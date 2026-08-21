package expo.modules.pricetagprinter

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.Build
import android.os.Handler
import android.os.Looper
import expo.modules.interfaces.permissions.PermissionsResponseListener
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * BLE raster transport for the Zhuhai Jiuyin N12 (FCC ID 2BM2R-N12).
 *
 * This printer does not implement Bluetooth SPP or ESC/POS. It receives
 * compressed 1-bit bitmap jobs through the Print Master/Nada-style BLE
 * service (FF00 / FF02) and may provide FF03 credit notifications.
 */
class PriceTagPrinterModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())
  private val stateLock = Any()

  private var gatt: BluetoothGatt? = null
  private var writeCharacteristic: BluetoothGattCharacteristic? = null
  private var connectedAddress: String? = null
  private var maxPacketBytes = DEFAULT_PACKET_BYTES
  private var writesWithoutResponse = false
  private var awaitingFlowDescriptor = false
  private var flowControlEnabled = false
  private var availableCredits = FALLBACK_CREDITS
  private var connectionContinuation: CancellableContinuation<Map<String, String>>? = null
  private var writeContinuation: CancellableContinuation<Unit>? = null
  private var creditContinuation: CancellableContinuation<Unit>? = null

  override fun definition() = ModuleDefinition {
    Name("PriceTagPrinter")

    AsyncFunction("getPermissionStatusAsync") {
      getPermissionStatus()
    }

    AsyncFunction("requestPermissionsAsync").SuspendBody<Map<String, Any>> {
      requestBluetoothPermissions()
    }

    AsyncFunction("scanForDevicesAsync").SuspendBody<List<Map<String, String>>> {
      withContext(Dispatchers.IO) {
        scanForDevices()
      }
    }

    AsyncFunction("connectAsync").SuspendBody { address: String ->
      withContext(Dispatchers.IO) {
        connect(address)
      }
    }

    AsyncFunction("printLabelAsync").SuspendBody { payload: Map<String, Any?> ->
      withContext(Dispatchers.IO) {
        printLabel(payload)
      }
    }

    AsyncFunction("disconnectAsync").SuspendBody<Unit> {
      withContext(Dispatchers.IO) {
        closeConnection()
      }
    }

    AsyncFunction("getConnectionStateAsync") {
      synchronized(stateLock) {
        mapOf(
          "connected" to (gatt != null && writeCharacteristic != null),
          "address" to connectedAddress
        )
      }
    }

    OnDestroy {
      closeConnection()
    }
  }

  private fun requiredRuntimePermissions(): Array<String> =
    when {
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ->
        arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ->
        arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
      else -> emptyArray()
    }

  private fun getPermissionStatus(): Map<String, Any> {
    val permissions = requiredRuntimePermissions()
    if (permissions.isEmpty()) {
      return mapOf("granted" to true, "canAskAgain" to true, "status" to "granted")
    }
    val granted = appContext.permissions?.hasGrantedPermissions(*permissions) == true
    return mapOf(
      "granted" to granted,
      "canAskAgain" to true,
      "status" to if (granted) "granted" else "denied"
    )
  }

  private suspend fun requestBluetoothPermissions(): Map<String, Any> {
    val permissions = requiredRuntimePermissions()
    if (permissions.isEmpty() || getPermissionStatus()["granted"] == true) {
      return getPermissionStatus()
    }

    val manager = appContext.permissions
      ?: throw IllegalStateException("BLUETOOTH_PERMISSION_UNAVAILABLE: Permission service is unavailable.")

    return suspendCancellableCoroutine { continuation ->
      val listener = PermissionsResponseListener {
        if (continuation.isActive) {
          continuation.resume(getPermissionStatus())
        }
      }
      manager.askForPermissions(listener, *permissions)
    }
  }

  private fun requireBluetoothPermission() {
    if (getPermissionStatus()["granted"] != true) {
      throw IllegalStateException(
        "BLUETOOTH_PERMISSION_REQUIRED: Allow Nearby devices access to find and connect to the N12."
      )
    }
  }

  @SuppressLint("MissingPermission")
  private fun bluetoothAdapter(): BluetoothAdapter {
    requireBluetoothPermission()
    val adapter = BluetoothAdapter.getDefaultAdapter()
      ?: throw IllegalStateException("BLUETOOTH_UNAVAILABLE: This Android device does not support Bluetooth.")
    if (!adapter.isEnabled) {
      throw IllegalStateException("BLUETOOTH_DISABLED: Turn on Bluetooth, then try again.")
    }
    return adapter
  }

  @SuppressLint("MissingPermission")
  private suspend fun scanForDevices(): List<Map<String, String>> {
    val scanner = bluetoothAdapter().bluetoothLeScanner
      ?: throw IllegalStateException("BLE_UNAVAILABLE: This Android device cannot scan for the N12.")
    val devices = linkedMapOf<String, Map<String, String>>()

    return suspendCancellableCoroutine { continuation ->
      val callback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
          val device = result.device ?: return
          val details = deviceToMap(device)
          devices[device.address] = details
        }

        override fun onScanFailed(errorCode: Int) {
          if (continuation.isActive) {
            continuation.resumeWithException(
              IllegalStateException(
                "N12_SCAN_FAILED: Android could not scan for nearby printers (error $errorCode)."
              )
            )
          }
        }
      }

      try {
        scanner.startScan(callback)
      } catch (error: SecurityException) {
        continuation.resumeWithException(
          IllegalStateException("BLUETOOTH_PERMISSION_REQUIRED: Allow Nearby devices access to find the N12.", error)
        )
        return@suspendCancellableCoroutine
      }

      val finishScan = Runnable {
        try {
          scanner.stopScan(callback)
        } catch (_: SecurityException) {
          // Permission failures are reported before a scan begins.
        }
        if (continuation.isActive) {
          val discovered = devices.values.sortedWith(
            compareByDescending<Map<String, String>> { device ->
              device["name"]?.contains("n12", ignoreCase = true) == true
            }.thenBy { device -> device["name"]?.lowercase() ?: "" }
          )
          continuation.resume(discovered)
        }
      }
      mainHandler.postDelayed(finishScan, SCAN_DURATION_MS)
      continuation.invokeOnCancellation {
        mainHandler.removeCallbacks(finishScan)
        try {
          scanner.stopScan(callback)
        } catch (_: SecurityException) {
          // Nothing else to clean up.
        }
      }
    }
  }

  @SuppressLint("MissingPermission")
  private fun deviceToMap(device: BluetoothDevice): Map<String, String> =
    mapOf(
      "name" to (device.name ?: "Unnamed nearby device"),
      "address" to device.address
    )

  @SuppressLint("MissingPermission")
  private suspend fun connect(address: String): Map<String, String> {
    val normalizedAddress = address.trim().uppercase()
    if (normalizedAddress.isBlank()) {
      throw IllegalArgumentException("PRINTER_ADDRESS_REQUIRED: Choose your nearby N12 in Settings before printing.")
    }
    synchronized(stateLock) {
      if (gatt != null && writeCharacteristic != null && connectedAddress == normalizedAddress) {
        return mapOf("name" to "N12 label printer", "address" to normalizedAddress)
      }
    }

    val adapter = bluetoothAdapter()
    val device = try {
      adapter.getRemoteDevice(normalizedAddress)
    } catch (error: IllegalArgumentException) {
      throw IllegalArgumentException("N12_ADDRESS_INVALID: Select the N12 from the nearby-printer list.", error)
    }

    closeConnection()
    val connection = withTimeoutOrNull(CONNECTION_TIMEOUT_MS) {
      suspendCancellableCoroutine { continuation ->
      synchronized(stateLock) {
        connectionContinuation = continuation
      }
      val context = appContext.reactContext?.applicationContext
        ?: run {
          synchronized(stateLock) { connectionContinuation = null }
          continuation.resumeWithException(
            IllegalStateException("N12_CONNECTION_UNAVAILABLE: Android could not create a Bluetooth connection.")
          )
          return@suspendCancellableCoroutine
        }

      val createdGatt = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
          device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
        } else {
          device.connectGatt(context, false, gattCallback)
        }
      } catch (error: SecurityException) {
        synchronized(stateLock) { connectionContinuation = null }
        continuation.resumeWithException(
          IllegalStateException("BLUETOOTH_PERMISSION_REQUIRED: Allow Nearby devices access to connect to the N12.", error)
        )
        return@suspendCancellableCoroutine
      }

      if (createdGatt == null) {
        synchronized(stateLock) { connectionContinuation = null }
        continuation.resumeWithException(
          IOException("N12_CONNECTION_FAILED: Android could not open a BLE connection to the selected printer.")
        )
      } else {
        synchronized(stateLock) {
          gatt = createdGatt
          connectedAddress = normalizedAddress
          maxPacketBytes = DEFAULT_PACKET_BYTES
          flowControlEnabled = false
          availableCredits = FALLBACK_CREDITS
        }
      }

      continuation.invokeOnCancellation {
        closeConnection()
      }
      }
    }
    return connection ?: run {
      closeConnection()
      throw IOException("N12_CONNECTION_TIMED_OUT: The N12 did not finish connecting. Wake it and try again.")
    }
  }

  private suspend fun printLabel(payload: Map<String, Any?>) {
    val lines = (payload["lines"] as? List<*>)
      ?.mapNotNull { value -> value as? String }
      ?.filter { line -> line.isNotBlank() }
      ?: emptyList()
    if (lines.isEmpty()) {
      throw IllegalArgumentException("N12_LABEL_EMPTY: This label has no printable fields.")
    }
    val hasConnection = synchronized(stateLock) { gatt != null && writeCharacteristic != null }
    if (!hasConnection) {
      throw IllegalStateException("PRINTER_NOT_CONNECTED: Select and connect your N12 before printing.")
    }
    sendPayload(createN12PrintJob(lines))
  }

  private fun createN12PrintJob(lines: List<String>): ByteArray {
    val bitmap = renderLabel(lines)
    val imagePayload = createImageCommand(bitmap)
    return ByteArrayOutputStream().apply {
      // Gap label, medium-dark density, start and align.
      write(byteArrayOf(0x1F, 0x80.toByte(), 0x01, 0x20))
      write(byteArrayOf(0x1F, 0x70, 0x01, 0x0B))
      write(byteArrayOf(0x1F, 0xC0.toByte(), 0x01, 0x00))
      write(byteArrayOf(0x1F, 0x11, 0x51))
      write(imagePayload)
      // Complete the job and advance to the next label.
      write(byteArrayOf(0x1F, 0xC0.toByte(), 0x01, 0x01))
      write(byteArrayOf(0x1F, 0x11, 0x50))
    }.toByteArray()
  }

  private fun renderLabel(lines: List<String>): Bitmap {
    val firstLineHeight = 16
    val standardLineHeight = 13
    val height = maxOf(MIN_LABEL_HEIGHT, LABEL_PADDING_Y * 2 + firstLineHeight + (lines.drop(1).size * standardLineHeight))
    val bitmap = Bitmap.createBitmap(LABEL_WIDTH_DOTS, height, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    canvas.drawColor(Color.WHITE)

    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.BLACK
      typeface = android.graphics.Typeface.create(android.graphics.Typeface.MONOSPACE, android.graphics.Typeface.NORMAL)
    }
    val maxWidth = LABEL_WIDTH_DOTS - (LABEL_PADDING_X * 2)
    var baseline = LABEL_PADDING_Y + 12
    lines.forEachIndexed { index, line ->
      paint.textSize = if (index == 0) 12f else 9f
      paint.typeface = android.graphics.Typeface.create(
        android.graphics.Typeface.MONOSPACE,
        if (index == 0) android.graphics.Typeface.BOLD else android.graphics.Typeface.NORMAL
      )
      canvas.drawText(ellipsizeLine(line, paint, maxWidth), LABEL_PADDING_X.toFloat(), baseline.toFloat(), paint)
      baseline += if (index == 0) firstLineHeight else standardLineHeight
    }
    return bitmap
  }

  private fun ellipsizeLine(line: String, paint: Paint, maxWidth: Int): String {
    if (paint.measureText(line) <= maxWidth) return line
    val priceStart = line.lastIndexOf(" $")
    if (priceStart > 0) {
      val price = line.substring(priceStart + 1)
      val available = maxWidth - paint.measureText(price) - 4
      if (available > 0) {
        val count = paint.breakText(line.substring(0, priceStart), true, available, null)
        return line.substring(0, count).trimEnd() + " " + price
      }
    }
    val count = paint.breakText(line, true, maxWidth - paint.measureText("…"), null)
    return if (count < line.length) line.substring(0, count).trimEnd() + "…" else line
  }

  private fun createImageCommand(bitmap: Bitmap): ByteArray {
    val bytesPerRow = (bitmap.width + 7) / 8
    val raster = ByteArray(bytesPerRow * bitmap.height)
    for (y in 0 until bitmap.height) {
      for (byteIndex in 0 until bytesPerRow) {
        var packed = 0
        for (bit in 0 until 8) {
          val x = (byteIndex * 8) + bit
          if (x < bitmap.width) {
            val color = bitmap.getPixel(x, y)
            val luminance = ((Color.red(color) * 299) + (Color.green(color) * 587) + (Color.blue(color) * 114)) / 1000
            if (luminance < 128) packed = packed or (0x80 shr bit)
          }
        }
        raster[(y * bytesPerRow) + byteIndex] = packed.toByte()
      }
    }

    val compressed = createN12ZlibStream(raster)
    return ByteArrayOutputStream().apply {
      // 0x1F 0x10 + byte width + height + compressed-length, all big-endian.
      write(0x1F)
      write(0x10)
      write((bytesPerRow shr 8) and 0xFF)
      write(bytesPerRow and 0xFF)
      write((bitmap.height shr 8) and 0xFF)
      write(bitmap.height and 0xFF)
      write((compressed.size shr 24) and 0xFF)
      write((compressed.size shr 16) and 0xFF)
      write((compressed.size shr 8) and 0xFF)
      write(compressed.size and 0xFF)
      write(compressed)
    }.toByteArray()
  }

  /**
   * The N12 accepts a ZLIB stream with a 1 KB window. A stored-deflate stream
   * has no back references, so splitting it into 1 KB blocks is both portable
   * and compatible with the printer's small decompressor.
   */
  private fun createN12ZlibStream(raster: ByteArray): ByteArray {
    return ByteArrayOutputStream().apply {
      write(0x28) // Deflate + 1 KB window.
      write(0x15) // Valid zlib flags for the 0x28 header.
      var offset = 0
      while (offset < raster.size) {
        val length = minOf(ZLIB_BLOCK_SIZE, raster.size - offset)
        val finalBlock = offset + length >= raster.size
        write(if (finalBlock) 0x01 else 0x00)
        write(length and 0xFF)
        write((length shr 8) and 0xFF)
        val inverse = length.inv() and 0xFFFF
        write(inverse and 0xFF)
        write((inverse shr 8) and 0xFF)
        write(raster, offset, length)
        offset += length
      }
      val checksum = adler32(raster)
      write((checksum shr 24) and 0xFF)
      write((checksum shr 16) and 0xFF)
      write((checksum shr 8) and 0xFF)
      write(checksum and 0xFF)
    }.toByteArray()
  }

  private fun adler32(data: ByteArray): Int {
    var s1 = 1
    var s2 = 0
    data.forEach { byte ->
      s1 = (s1 + (byte.toInt() and 0xFF)) % 65521
      s2 = (s2 + s1) % 65521
    }
    return (s2 shl 16) or s1
  }

  private suspend fun sendPayload(payload: ByteArray) {
    var offset = 0
    while (offset < payload.size) {
      val packetSize = synchronized(stateLock) { maxPacketBytes.coerceIn(20, MAX_PACKET_BYTES) }
      val end = minOf(offset + packetSize, payload.size)
      consumeFlowCredit()
      writePacket(payload.copyOfRange(offset, end))
      offset = end
      delay(PACKET_DELAY_MS)
    }
  }

  private suspend fun consumeFlowCredit() {
    val shouldWait = synchronized(stateLock) {
      if (!flowControlEnabled) {
        false
      } else if (availableCredits > 0) {
        availableCredits -= 1
        false
      } else {
        true
      }
    }
    if (!shouldWait) return

    val receivedCredit = withTimeoutOrNull(FLOW_CONTROL_TIMEOUT_MS) {
      suspendCancellableCoroutine<Unit> { continuation ->
        val useAvailableCredit = synchronized(stateLock) {
          if (availableCredits > 0) {
            availableCredits -= 1
            true
          } else {
            creditContinuation = continuation
            false
          }
        }
        if (useAvailableCredit) {
          continuation.resume(Unit)
        }
        continuation.invokeOnCancellation {
          synchronized(stateLock) {
            if (creditContinuation === continuation) creditContinuation = null
          }
        }
      }
    }
    if (receivedCredit == null) {
      // Some N12 firmware versions omit FF03 notifications. Continue safely
      // with paced writes rather than leaving the user in an endless print state.
      synchronized(stateLock) {
        flowControlEnabled = false
        availableCredits = FALLBACK_CREDITS
      }
    }
  }

  @SuppressLint("MissingPermission")
  private suspend fun writePacket(packet: ByteArray) {
    val activeGatt: BluetoothGatt
    val characteristic: BluetoothGattCharacteristic
    val writeWithoutResponse: Boolean
    synchronized(stateLock) {
      activeGatt = gatt ?: throw IllegalStateException("PRINTER_NOT_CONNECTED: Reconnect your N12 before printing.")
      characteristic = writeCharacteristic
        ?: throw IllegalStateException("N12_PROTOCOL_UNAVAILABLE: The selected device is not exposing the N12 print service.")
      writeWithoutResponse = writesWithoutResponse
    }

    characteristic.writeType =
      if (writeWithoutResponse) {
        BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
      } else {
        BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
      }
    characteristic.value = packet

    if (writeWithoutResponse) {
      @Suppress("DEPRECATION")
      if (!activeGatt.writeCharacteristic(characteristic)) {
        throw IOException("N12_WRITE_FAILED: The N12 did not accept a label packet. Keep it powered on and try again.")
      }
      return
    }

    val writeCompleted = withTimeoutOrNull(PACKET_WRITE_TIMEOUT_MS) {
      suspendCancellableCoroutine<Unit> { continuation ->
      synchronized(stateLock) {
        writeContinuation = continuation
      }
      @Suppress("DEPRECATION")
      val queued = activeGatt.writeCharacteristic(characteristic)
      if (!queued) {
        synchronized(stateLock) {
          if (writeContinuation === continuation) writeContinuation = null
        }
        continuation.resumeWithException(
          IOException("N12_WRITE_FAILED: The printer did not accept a label packet. Keep it powered on and try again.")
        )
      }
      continuation.invokeOnCancellation {
        synchronized(stateLock) {
          if (writeContinuation === continuation) writeContinuation = null
        }
      }
      }
    }
    if (writeCompleted == null) {
      synchronized(stateLock) {
        writeContinuation = null
      }
      throw IOException("N12_WRITE_TIMED_OUT: The N12 stopped acknowledging a label packet. Reconnect and try again.")
    }
  }

  private val gattCallback = object : BluetoothGattCallback() {
    override fun onConnectionStateChange(activeGatt: BluetoothGatt, status: Int, newState: Int) {
      if (status != BluetoothGatt.GATT_SUCCESS) {
        closeConnection(IOException("N12_CONNECTION_FAILED: The N12 disconnected during setup (status $status)."))
        return
      }
      if (newState == BluetoothProfile.STATE_CONNECTED) {
        if (!activeGatt.discoverServices()) {
          closeConnection(IOException("N12_SERVICE_DISCOVERY_FAILED: Android could not inspect the N12 print service."))
        }
      } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
        closeConnection(IOException("N12_DISCONNECTED: The N12 disconnected. Wake it and reconnect before printing."))
      }
    }

    override fun onServicesDiscovered(activeGatt: BluetoothGatt, status: Int) {
      if (status != BluetoothGatt.GATT_SUCCESS) {
        closeConnection(IOException("N12_SERVICE_DISCOVERY_FAILED: Android could not inspect the N12 print service."))
        return
      }
      val service = activeGatt.getService(PRINTER_SERVICE_UUID)
      if (service == null) {
        closeConnection(
          IllegalStateException("N12_PROTOCOL_UNAVAILABLE: The selected device is not a compatible Zhuhai Jiuyin N12 printer.")
        )
        return
      }
      val output = service.getCharacteristic(WRITE_CHARACTERISTIC_UUID)
      if (output == null) {
        closeConnection(
          IllegalStateException("N12_PROTOCOL_UNAVAILABLE: The selected device is not a compatible Zhuhai Jiuyin N12 printer.")
        )
        return
      }

      val flow = service.getCharacteristic(FLOW_CONTROL_CHARACTERISTIC_UUID)
      val supportsWrite = output.properties and BluetoothGattCharacteristic.PROPERTY_WRITE != 0
      val supportsWriteWithoutResponse =
        output.properties and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0
      if (!supportsWrite && !supportsWriteWithoutResponse) {
        closeConnection(
          IllegalStateException("N12_PROTOCOL_UNAVAILABLE: The N12 print service does not allow label writes.")
        )
        return
      }
      synchronized(stateLock) {
        writeCharacteristic = output
        writesWithoutResponse = supportsWriteWithoutResponse
        flowControlEnabled = false
        availableCredits = FALLBACK_CREDITS
      }

      if (
        flow != null &&
        flow.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0 &&
        activeGatt.setCharacteristicNotification(flow, true)
      ) {
        val descriptor = flow.getDescriptor(CLIENT_CONFIGURATION_UUID)
        if (descriptor != null) {
          descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
          synchronized(stateLock) {
            awaitingFlowDescriptor = true
          }
          @Suppress("DEPRECATION")
          if (activeGatt.writeDescriptor(descriptor)) {
            return
          }
          synchronized(stateLock) {
            awaitingFlowDescriptor = false
          }
        }
      }
      requestMtuOrComplete(activeGatt)
    }

    override fun onDescriptorWrite(
      activeGatt: BluetoothGatt,
      descriptor: BluetoothGattDescriptor,
      status: Int
    ) {
      if (descriptor.characteristic.uuid != FLOW_CONTROL_CHARACTERISTIC_UUID) return
      synchronized(stateLock) {
        awaitingFlowDescriptor = false
        flowControlEnabled = status == BluetoothGatt.GATT_SUCCESS
        availableCredits = if (flowControlEnabled) 0 else FALLBACK_CREDITS
      }
      requestMtuOrComplete(activeGatt)
    }

    override fun onMtuChanged(activeGatt: BluetoothGatt, mtu: Int, status: Int) {
      if (status == BluetoothGatt.GATT_SUCCESS) {
        synchronized(stateLock) {
          maxPacketBytes = (mtu - 3).coerceIn(20, MAX_PACKET_BYTES)
        }
      }
      completeConnection()
    }

    override fun onCharacteristicChanged(
      activeGatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      value: ByteArray
    ) {
      if (characteristic.uuid != FLOW_CONTROL_CHARACTERISTIC_UUID || value.size < 2 || value[0] != 0x01.toByte()) {
        return
      }
      val continuation = synchronized(stateLock) {
        availableCredits += (value[1].toInt() and 0xFF)
        if (availableCredits > 0 && creditContinuation != null) {
          availableCredits -= 1
          creditContinuation.also { creditContinuation = null }
        } else {
          null
        }
      }
      continuation?.let { waiter ->
        if (waiter.isActive) waiter.resume(Unit)
      }
    }

    @Deprecated("Deprecated in Java")
    override fun onCharacteristicChanged(activeGatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
      onCharacteristicChanged(activeGatt, characteristic, characteristic.value ?: byteArrayOf())
    }

    override fun onCharacteristicWrite(
      activeGatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      status: Int
    ) {
      val continuation = synchronized(stateLock) {
        writeContinuation.also { writeContinuation = null }
      }
      continuation?.let { pending ->
        if (!pending.isActive) return@let
        if (status == BluetoothGatt.GATT_SUCCESS) {
          pending.resume(Unit)
        } else {
          pending.resumeWithException(
            IOException("N12_WRITE_FAILED: The N12 rejected a label packet (status $status).")
          )
        }
      }
    }
  }

  private fun completeConnection() {
    val continuation = synchronized(stateLock) {
      connectionContinuation.also { connectionContinuation = null }
    }
    if (continuation?.isActive == true) {
      val address = synchronized(stateLock) { connectedAddress } ?: ""
      continuation.resume(mapOf("name" to "N12 label printer", "address" to address))
    }
  }

  private fun requestMtuOrComplete(activeGatt: BluetoothGatt) {
    if (!activeGatt.requestMtu(REQUESTED_MTU)) {
      completeConnection()
    }
  }

  private fun closeConnection(reason: Throwable? = null) {
    val toFailConnection: CancellableContinuation<Map<String, String>>?
    val toFailWrite: CancellableContinuation<Unit>?
    val toFailCredit: CancellableContinuation<Unit>?
    val activeGatt: BluetoothGatt?
    synchronized(stateLock) {
      toFailConnection = connectionContinuation
      toFailWrite = writeContinuation
      toFailCredit = creditContinuation
      connectionContinuation = null
      writeContinuation = null
      creditContinuation = null
      activeGatt = gatt
      gatt = null
      writeCharacteristic = null
      connectedAddress = null
      writesWithoutResponse = false
      awaitingFlowDescriptor = false
      flowControlEnabled = false
      availableCredits = FALLBACK_CREDITS
      maxPacketBytes = DEFAULT_PACKET_BYTES
    }
    try {
      activeGatt?.disconnect()
      activeGatt?.close()
    } catch (_: SecurityException) {
      // The Android connection is already being released.
    }
    if (reason != null) {
      if (toFailConnection?.isActive == true) toFailConnection.resumeWithException(reason)
      if (toFailWrite?.isActive == true) toFailWrite.resumeWithException(reason)
      if (toFailCredit?.isActive == true) toFailCredit.resumeWithException(reason)
    }
  }

  companion object {
    private val PRINTER_SERVICE_UUID: UUID = UUID.fromString("0000ff00-0000-1000-8000-00805f9b34fb")
    private val WRITE_CHARACTERISTIC_UUID: UUID = UUID.fromString("0000ff02-0000-1000-8000-00805f9b34fb")
    private val FLOW_CONTROL_CHARACTERISTIC_UUID: UUID = UUID.fromString("0000ff03-0000-1000-8000-00805f9b34fb")
    private val CLIENT_CONFIGURATION_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

    private const val SCAN_DURATION_MS = 6_000L
    private const val FLOW_CONTROL_TIMEOUT_MS = 1_500L
    private const val CONNECTION_TIMEOUT_MS = 12_000L
    private const val PACKET_WRITE_TIMEOUT_MS = 3_000L
    private const val PACKET_DELAY_MS = 3L
    private const val REQUESTED_MTU = 247
    private const val DEFAULT_PACKET_BYTES = 20
    private const val MAX_PACKET_BYTES = 200
    private const val FALLBACK_CREDITS = 1_000
    private const val ZLIB_BLOCK_SIZE = 1_024

    // 12 mm at 203 dpi is approximately 96 thermal dots across.
    private const val LABEL_WIDTH_DOTS = 96
    private const val LABEL_PADDING_X = 4
    private const val LABEL_PADDING_Y = 6
    private const val MIN_LABEL_HEIGHT = 112
  }
}