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
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.Collections
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
  private val printMutex = Mutex()

  private var gatt: BluetoothGatt? = null
  private var writeCharacteristic: BluetoothGattCharacteristic? = null
  private var flowCharacteristic: BluetoothGattCharacteristic? = null
  private var connectedAddress: String? = null
  private var writesWithoutResponse = false
  private var flowControlEnabled = false
  private var flowControlSetupPending = false
  private var flowControlSetupExpired = false
  private var firstFlowCreditPending = false
  private var availableFlowCredits = FALLBACK_FLOW_CREDITS
  private var connectionAttemptId = 0L
  private var reservedConnectionAttemptId: Long? = null
  private var pendingConnectionAttemptId: Long? = null
  private var connectionContinuation: CancellableContinuation<Map<String, String>>? = null
  private var writeContinuation: CancellableContinuation<Unit>? = null
  private var flowCreditContinuation: CancellableContinuation<Unit>? = null
  private var writeAttemptId = 0L
  private var pendingWriteAttemptId: Long? = null

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
        closeConnection(
          IOException("N12_CONNECTION_CANCELLED: The N12 connection was cancelled before it finished.")
        )
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
    val adapter = bluetoothAdapter()
    val scanner = adapter.bluetoothLeScanner
      ?: throw IllegalStateException("BLE_UNAVAILABLE: This Android device cannot scan for the N12.")
    val devices = Collections.synchronizedMap(linkedMapOf<String, Map<String, String>>())

    // Some N12 firmware stops advertising while it is paired. Including bonded
    // devices lets a user reconnect without first removing the pairing in Android.
    adapter.bondedDevices.forEach { device ->
      devices[device.address] = deviceToMap(device)
    }

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
          val discovered = synchronized(devices) {
            devices.values
              .sortedWith(
                compareByDescending<Map<String, String>> { device ->
                  device["name"]?.contains("n12", ignoreCase = true) == true
                }.thenBy { device -> device["name"]?.lowercase() ?: "" }
              )
          }
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
    val connectionAttempt = synchronized(stateLock) {
      if (reservedConnectionAttemptId != null || connectionContinuation != null) {
        throw IllegalStateException("N12_CONNECTION_IN_PROGRESS: Wait for the current N12 connection attempt to finish.")
      }
      if (gatt != null && writeCharacteristic != null && connectedAddress == normalizedAddress) {
        return mapOf("name" to "N12 label printer", "address" to normalizedAddress)
      }
      connectionAttemptId += 1
      reservedConnectionAttemptId = connectionAttemptId
      Pair(connectionAttemptId, gatt != null)
    }

    val adapter = try {
      bluetoothAdapter()
    } catch (error: Throwable) {
      releaseConnectionReservation(connectionAttempt.first)
      throw error
    }
    val device = try {
      adapter.getRemoteDevice(normalizedAddress)
    } catch (error: IllegalArgumentException) {
      releaseConnectionReservation(connectionAttempt.first)
      throw IllegalArgumentException("N12_ADDRESS_INVALID: Select the N12 from the nearby-printer list.", error)
    }

    if (connectionAttempt.second) {
      // A short gap after closing a stale GATT prevents common Android 133
      // reconnect failures on printers that do not release the radio instantly.
      closeConnection(
        IOException("N12_CONNECTION_REPLACED: The previous N12 connection was closed to start a new one."),
        preserveConnectionReservation = true
      )
      delay(GATT_RECONNECT_DELAY_MS)
    }
    val connection = withTimeoutOrNull(CONNECTION_TIMEOUT_MS) {
      suspendCancellableCoroutine { continuation ->
      val attemptId = connectionAttempt.first
      val registered = synchronized(stateLock) {
        if (reservedConnectionAttemptId != attemptId) {
          false
        } else {
          pendingConnectionAttemptId = attemptId
          connectionContinuation = continuation
          connectedAddress = normalizedAddress
          true
        }
      }
      if (!registered) {
        continuation.resumeWithException(
          IOException("N12_CONNECTION_CANCELLED: The N12 connection attempt was cancelled.")
        )
        return@suspendCancellableCoroutine
      }
      val context = appContext.reactContext?.applicationContext
        ?: run {
          clearConnectionAttempt(continuation, attemptId)
          continuation.resumeWithException(
            IllegalStateException("N12_CONNECTION_UNAVAILABLE: Android could not create a Bluetooth connection.")
          )
          return@suspendCancellableCoroutine
        }

      val createdGatt = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
          device.connectGatt(context, false, createGattCallback(attemptId), BluetoothDevice.TRANSPORT_LE)
        } else {
          device.connectGatt(context, false, createGattCallback(attemptId))
        }
      } catch (error: SecurityException) {
        clearConnectionAttempt(continuation, attemptId)
        continuation.resumeWithException(
          IllegalStateException("BLUETOOTH_PERMISSION_REQUIRED: Allow Nearby devices access to connect to the N12.", error)
        )
        return@suspendCancellableCoroutine
      }

      if (createdGatt == null) {
        clearConnectionAttempt(continuation, attemptId)
        continuation.resumeWithException(
          IOException("N12_CONNECTION_FAILED: Android could not open a BLE connection to the selected printer.")
        )
      } else {
        val shouldCloseCreatedGatt = synchronized(stateLock) {
          if (pendingConnectionAttemptId == attemptId && gatt == null) {
            gatt = createdGatt
            false
          } else {
            gatt !== createdGatt
          }
        }
        if (shouldCloseCreatedGatt) {
          try {
            createdGatt.disconnect()
            createdGatt.close()
          } catch (_: SecurityException) {
            // The connection attempt is already being released.
          }
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

  private suspend fun printLabel(payload: Map<String, Any?>): Map<String, Any?> {
    if (!printMutex.tryLock()) {
      throw IllegalStateException("N12_PRINT_IN_PROGRESS: Wait for the current N12 label to finish before sending another.")
    }
    try {
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
      val job = createN12PrintJob(lines)
      val rasterDelivery = sendPayload(job.headerAndImage)
      // The printer needs time to decompress and stage the raster before it
      // receives the stop/feed footer. Sending both phases back-to-back can
      // look successful at the BLE layer while the N12 silently drops the job.
      delay(PRINT_RASTER_PROCESSING_DELAY_MS)
      val footerDelivery = sendPayload(job.footer)
      // Keep the GATT link up while the printer starts the physical feed.
      delay(PRINT_DISPATCH_SETTLE_MS)
      val result = combineDeliveryResults(rasterDelivery, footerDelivery)
      return mapOf(
        "packetCount" to result.packetCount,
        "acknowledgedPacketCount" to result.acknowledgedPacketCount,
        "writeMode" to result.writeMode,
        "packetBytes" to result.packetBytes,
        "usedFlowControl" to result.usedFlowControl
      )
    } finally {
      printMutex.unlock()
    }
  }

  private fun createN12PrintJob(lines: List<String>): N12PrintJob {
    val bitmap = renderLabel(lines)
    val imagePayload = createImageCommand(bitmap)
    val headerAndImage = ByteArrayOutputStream().apply {
      // Gap label, medium-dark density, start and align.
      write(byteArrayOf(0x1F, 0x80.toByte(), 0x01, 0x20))
      write(byteArrayOf(0x1F, 0x70, 0x01, 0x0B))
      write(byteArrayOf(0x1F, 0xC0.toByte(), 0x01, 0x00))
      write(byteArrayOf(0x1F, 0x11, 0x51))
      write(imagePayload)
    }.toByteArray()
    val footer = ByteArrayOutputStream().apply {
      // Complete the job and advance to the next label only after the N12
      // has had time to stage the full compressed raster.
      write(byteArrayOf(0x1F, 0xC0.toByte(), 0x01, 0x01))
      write(byteArrayOf(0x1F, 0x11, 0x50))
    }.toByteArray()
    return N12PrintJob(headerAndImage, footer)
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

  private suspend fun sendPayload(payload: ByteArray): PrintDeliveryResult {
    var offset = 0
    var packetCount = 0
    var acknowledgedPacketCount = 0
    var usedFlowControl = false
    var largestPacketBytes = DEFAULT_PACKET_BYTES
    var writeMode = "acknowledged"
    while (offset < payload.size) {
      val end = minOf(offset + DEFAULT_PACKET_BYTES, payload.size)
      usedFlowControl = consumeFlowCredit() || usedFlowControl
      val acknowledged = writePacket(payload.copyOfRange(offset, end))
      offset = end
      packetCount += 1
      if (acknowledged) {
        acknowledgedPacketCount += 1
      } else {
        writeMode = "no-response-queued"
      }
      delay(PACKET_DELAY_MS)
    }
    return PrintDeliveryResult(
      packetCount = packetCount,
      acknowledgedPacketCount = acknowledgedPacketCount,
      writeMode = writeMode,
      packetBytes = largestPacketBytes,
      usedFlowControl = usedFlowControl
    )
  }

  private fun combineDeliveryResults(
    rasterDelivery: PrintDeliveryResult,
    footerDelivery: PrintDeliveryResult
  ): PrintDeliveryResult {
    return PrintDeliveryResult(
      packetCount = rasterDelivery.packetCount + footerDelivery.packetCount,
      acknowledgedPacketCount = rasterDelivery.acknowledgedPacketCount + footerDelivery.acknowledgedPacketCount,
      writeMode = if (
        rasterDelivery.writeMode == "no-response-queued" ||
        footerDelivery.writeMode == "no-response-queued"
      ) {
        "no-response-queued"
      } else {
        "acknowledged"
      },
      packetBytes = maxOf(rasterDelivery.packetBytes, footerDelivery.packetBytes),
      usedFlowControl = rasterDelivery.usedFlowControl || footerDelivery.usedFlowControl
    )
  }

  private suspend fun consumeFlowCredit(): Boolean {
    var activeGatt: BluetoothGatt? = null
    val availableCredit = synchronized(stateLock) {
      activeGatt = gatt
      if (!flowControlEnabled) {
        false
      } else if (availableFlowCredits > 0) {
        availableFlowCredits -= 1
        true
      } else {
        null
      }
    }
    if (availableCredit != null) return availableCredit

    val receivedCredit = withTimeoutOrNull(FLOW_CREDIT_TIMEOUT_MS) {
      suspendCancellableCoroutine<Unit> { continuation ->
        val canSend = synchronized(stateLock) {
          when {
            !flowControlEnabled -> true
            availableFlowCredits > 0 -> {
              availableFlowCredits -= 1
              true
            }
            else -> {
              flowCreditContinuation = continuation
              false
            }
          }
        }
        if (canSend) {
          continuation.resume(Unit)
        }
        continuation.invokeOnCancellation {
          synchronized(stateLock) {
            if (flowCreditContinuation === continuation) {
              flowCreditContinuation = null
            }
          }
        }
      }
    }

    if (receivedCredit == null) {
      val canFallBack = synchronized(stateLock) {
        if (flowControlEnabled && firstFlowCreditPending) {
          // A subscribed FF03 characteristic did not send its initial grant.
          // Treat it as an optional feature for this connection rather than
          // making the first print wait forever.
          flowControlEnabled = false
          firstFlowCreditPending = false
          availableFlowCredits = FALLBACK_FLOW_CREDITS
          flowCreditContinuation = null
          true
        } else {
          false
        }
      }
      if (!canFallBack) {
        val error = IOException(
          "N12_FLOW_CONTROL_TIMED_OUT: The N12 stopped granting print-buffer credits. Reconnect and try again."
        )
        activeGatt?.let { closeConnection(it, error) }
        throw error
      }
      return false
    }
    return true
  }

  @SuppressLint("MissingPermission")
  private suspend fun writePacket(packet: ByteArray): Boolean {
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
      // Android does not reliably invoke onCharacteristicWrite for
      // WRITE_TYPE_NO_RESPONSE. The paced send loop is the acknowledgement
      // mechanism in this mode, so waiting for that callback causes false
      // connection/printing timeouts.
      val queued = try {
        @Suppress("DEPRECATION")
        activeGatt.writeCharacteristic(characteristic)
      } catch (error: SecurityException) {
        throw IllegalStateException(
          "BLUETOOTH_PERMISSION_REQUIRED: Allow Nearby devices access to keep printing to the N12.",
          error
        )
      }
      if (!queued) {
        throw IOException("N12_WRITE_FAILED: The printer did not accept a label packet. Keep it powered on and try again.")
      }
      return false
    }

    val writeCompleted = withTimeoutOrNull(PACKET_WRITE_TIMEOUT_MS) {
      suspendCancellableCoroutine<Unit> { continuation ->
        val attemptId = synchronized(stateLock) {
          writeAttemptId += 1
          pendingWriteAttemptId = writeAttemptId
          writeContinuation = continuation
          writeAttemptId
        }
       val queued = try {
         @Suppress("DEPRECATION")
         activeGatt.writeCharacteristic(characteristic)
       } catch (error: SecurityException) {
         synchronized(stateLock) {
            if (writeContinuation === continuation && pendingWriteAttemptId == attemptId) {
              writeContinuation = null
              pendingWriteAttemptId = null
            }
         }
         continuation.resumeWithException(
           IllegalStateException(
             "BLUETOOTH_PERMISSION_REQUIRED: Allow Nearby devices access to keep printing to the N12.",
             error
           )
         )
         return@suspendCancellableCoroutine
       }
        if (!queued) {
          synchronized(stateLock) {
            if (writeContinuation === continuation && pendingWriteAttemptId == attemptId) {
              writeContinuation = null
              pendingWriteAttemptId = null
            }
          }
          continuation.resumeWithException(
            IOException("N12_WRITE_FAILED: The printer did not accept a label packet. Keep it powered on and try again.")
          )
        }
        continuation.invokeOnCancellation {
          val wasPending = synchronized(stateLock) {
            if (writeContinuation === continuation && pendingWriteAttemptId == attemptId) {
              writeContinuation = null
              pendingWriteAttemptId = null
              true
            } else {
              false
            }
          }
          if (wasPending) {
            // The callback for a cancelled or timed-out Android GATT operation
            // can arrive late. Closing this session prevents it from being
            // mistaken for a callback for a later packet.
            closeConnection(activeGatt, null)
          }
        }
      }
    }
    if (writeCompleted == null) {
      throw IOException("N12_WRITE_TIMED_OUT: The N12 stopped acknowledging a label packet. Reconnect and try again.")
    }
    return true
  }

  private fun createGattCallback(attemptId: Long) = object : BluetoothGattCallback() {
    override fun onConnectionStateChange(activeGatt: BluetoothGatt, status: Int, newState: Int) {
      if (!isCurrentGatt(activeGatt, attemptId)) return
      if (status != BluetoothGatt.GATT_SUCCESS) {
        closeConnection(activeGatt, IOException("N12_CONNECTION_FAILED: The N12 disconnected during setup (status $status)."))
        return
      }
      if (newState == BluetoothProfile.STATE_CONNECTED) {
        if (!activeGatt.discoverServices()) {
          closeConnection(activeGatt, IOException("N12_SERVICE_DISCOVERY_FAILED: Android could not inspect the N12 print service."))
        }
      } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
        closeConnection(activeGatt, IOException("N12_DISCONNECTED: The N12 disconnected. Wake it and reconnect before printing."))
      }
    }

    override fun onServicesDiscovered(activeGatt: BluetoothGatt, status: Int) {
      if (!isCurrentGatt(activeGatt, attemptId)) return
      if (status != BluetoothGatt.GATT_SUCCESS) {
        closeConnection(activeGatt, IOException("N12_SERVICE_DISCOVERY_FAILED: Android could not inspect the N12 print service."))
        return
      }
      val service = activeGatt.getService(PRINTER_SERVICE_UUID)
      if (service == null) {
        closeConnection(activeGatt,
          IllegalStateException("N12_PROTOCOL_UNAVAILABLE: The selected device is not a compatible Zhuhai Jiuyin N12 printer.")
        )
        return
      }
      val output = service.getCharacteristic(WRITE_CHARACTERISTIC_UUID)
      if (output == null) {
        closeConnection(activeGatt,
          IllegalStateException("N12_PROTOCOL_UNAVAILABLE: The selected device is not a compatible Zhuhai Jiuyin N12 printer.")
        )
        return
      }

      val supportsWrite = output.properties and BluetoothGattCharacteristic.PROPERTY_WRITE != 0
      val supportsWriteWithoutResponse =
        output.properties and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0
      if (!supportsWrite && !supportsWriteWithoutResponse) {
        closeConnection(activeGatt,
          IllegalStateException("N12_PROTOCOL_UNAVAILABLE: The N12 print service does not allow label writes.")
        )
        return
      }
      synchronized(stateLock) {
        writeCharacteristic = output
        // Prefer acknowledged writes whenever the printer exposes them. On N12
        // firmware that supports both modes, WRITE_NO_RESPONSE only confirms
        // Android accepted the packet locally; it cannot tell us whether the
        // printer received the raster data.
        writesWithoutResponse = !supportsWrite && supportsWriteWithoutResponse
      }

      synchronized(stateLock) {
        flowCharacteristic = null
        flowControlEnabled = false
        flowControlSetupPending = false
        flowControlSetupExpired = false
        firstFlowCreditPending = false
        availableFlowCredits = FALLBACK_FLOW_CREDITS
      }
      scheduleConnectionCompletion(activeGatt, attemptId, PRINTER_READY_DELAY_MS)
    }

    override fun onCharacteristicChanged(
      activeGatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      value: ByteArray
    ) {
      handleFlowControlNotification(activeGatt, attemptId, characteristic, value)
    }

    @Suppress("DEPRECATION")
    override fun onCharacteristicChanged(
      activeGatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic
    ) {
      handleFlowControlNotification(
        activeGatt,
        attemptId,
        characteristic,
        characteristic.value ?: byteArrayOf()
      )
    }

    override fun onCharacteristicWrite(
      activeGatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      status: Int
    ) {
      if (!isCurrentGatt(activeGatt, attemptId)) return
      if (characteristic.uuid != WRITE_CHARACTERISTIC_UUID) return
      val continuation = synchronized(stateLock) {
        if (pendingWriteAttemptId == null) {
          null
        } else {
          pendingWriteAttemptId = null
          writeContinuation.also { writeContinuation = null }
        }
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

  private fun handleFlowControlNotification(
    activeGatt: BluetoothGatt,
    attemptId: Long,
    characteristic: BluetoothGattCharacteristic,
    value: ByteArray
  ) {
    if (!isCurrentGatt(activeGatt, attemptId)) return
    if (characteristic.uuid != FLOW_CONTROL_CHARACTERISTIC_UUID || value.size < 2 || value[0].toInt() != 0x01) {
      return
    }
    val continuation = synchronized(stateLock) {
      if (!flowControlEnabled && !(flowControlSetupPending && !flowControlSetupExpired)) {
        null
      } else {
        // Protocol 0x01 grants one packet credit per unit. Existing
        // PrintMaster implementations preserve 0x04 as four credits.
        val granted = value[1].toInt() and 0xFF
        availableFlowCredits += if (granted == 0x04) 4 else granted
        if (availableFlowCredits > 0) {
          firstFlowCreditPending = false
        }
        if (availableFlowCredits > 0) {
          flowCreditContinuation?.also {
            availableFlowCredits -= 1
            flowCreditContinuation = null
          }
        } else {
          null
        }
      }
    }
    if (continuation?.isActive == true) {
      continuation.resume(Unit)
    }
  }

  private fun scheduleConnectionCompletion(
    activeGatt: BluetoothGatt,
    attemptId: Long,
    delayMs: Long
  ) {
    mainHandler.postDelayed(
      {
        val canComplete = synchronized(stateLock) {
          if (
            gatt !== activeGatt ||
            pendingConnectionAttemptId != attemptId ||
            connectionContinuation == null
          ) {
            false
          } else {
            true
          }
        }
        if (canComplete) {
          completeConnection(activeGatt)
        }
      },
      delayMs
    )
  }

  private fun isCurrentGatt(candidate: BluetoothGatt, attemptId: Long): Boolean =
    synchronized(stateLock) {
      if (gatt === candidate) {
        true
      } else if (
        gatt == null &&
        pendingConnectionAttemptId == attemptId &&
        connectionContinuation != null
      ) {
        // Android can dispatch a connection callback before connectGatt
        // returns. This callback owns only its matching attempt.
        gatt = candidate
        true
      } else {
        false
      }
    }

  private fun completeConnection(activeGatt: BluetoothGatt) {
    if (synchronized(stateLock) { gatt !== activeGatt }) return
    val continuation = synchronized(stateLock) {
      pendingConnectionAttemptId = null
      reservedConnectionAttemptId = null
      connectionContinuation.also { connectionContinuation = null }
    }
    if (continuation?.isActive == true) {
      val address = synchronized(stateLock) { connectedAddress } ?: ""
      continuation.resume(mapOf("name" to "N12 label printer", "address" to address))
    }
  }

  private fun clearConnectionAttempt(
    continuation: CancellableContinuation<Map<String, String>>,
    attemptId: Long
  ) {
    synchronized(stateLock) {
      if (connectionContinuation === continuation && pendingConnectionAttemptId == attemptId) {
        connectionContinuation = null
        pendingConnectionAttemptId = null
        reservedConnectionAttemptId = null
        connectedAddress = null
      }
    }
  }

  private fun releaseConnectionReservation(attemptId: Long) {
    synchronized(stateLock) {
      if (reservedConnectionAttemptId == attemptId) {
        reservedConnectionAttemptId = null
      }
    }
  }

  private fun closeConnection(
    reason: Throwable? = null,
    preserveConnectionReservation: Boolean = false
  ) {
    closeConnection(
      expectedGatt = null,
      reason = reason,
      preserveConnectionReservation = preserveConnectionReservation
    )
  }

  private fun closeConnection(
    expectedGatt: BluetoothGatt?,
    reason: Throwable?,
    preserveConnectionReservation: Boolean = false
  ) {
    val toFailConnection: CancellableContinuation<Map<String, String>>?
    val toFailWrite: CancellableContinuation<Unit>?
    val toFailFlowCredit: CancellableContinuation<Unit>?
    val activeGatt: BluetoothGatt?
    synchronized(stateLock) {
      if (expectedGatt != null && gatt !== expectedGatt) return
      toFailConnection = connectionContinuation
      toFailWrite = writeContinuation
      toFailFlowCredit = flowCreditContinuation
      connectionContinuation = null
      writeContinuation = null
      pendingWriteAttemptId = null
      flowCreditContinuation = null
      pendingConnectionAttemptId = null
      if (!preserveConnectionReservation) {
        reservedConnectionAttemptId = null
      }
      activeGatt = gatt
      gatt = null
      writeCharacteristic = null
      flowCharacteristic = null
      connectedAddress = null
      writesWithoutResponse = false
      flowControlEnabled = false
      flowControlSetupPending = false
      flowControlSetupExpired = false
      firstFlowCreditPending = false
      availableFlowCredits = FALLBACK_FLOW_CREDITS
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
      if (toFailFlowCredit?.isActive == true) toFailFlowCredit.resumeWithException(reason)
    }
  }

  companion object {
    private data class PrintDeliveryResult(
      val packetCount: Int,
      val acknowledgedPacketCount: Int,
      val writeMode: String,
      val packetBytes: Int,
      val usedFlowControl: Boolean
    )

    private data class N12PrintJob(
      val headerAndImage: ByteArray,
      val footer: ByteArray
    )

    private val PRINTER_SERVICE_UUID: UUID = UUID.fromString("0000ff00-0000-1000-8000-00805f9b34fb")
    private val WRITE_CHARACTERISTIC_UUID: UUID = UUID.fromString("0000ff02-0000-1000-8000-00805f9b34fb")
    private val FLOW_CONTROL_CHARACTERISTIC_UUID: UUID = UUID.fromString("0000ff03-0000-1000-8000-00805f9b34fb")
    private val CLIENT_CHARACTERISTIC_CONFIG_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

    private const val SCAN_DURATION_MS = 6_000L
    private const val CONNECTION_TIMEOUT_MS = 12_000L
    private const val PACKET_WRITE_TIMEOUT_MS = 3_000L
    private const val PACKET_DELAY_MS = 3L
    private const val PRINTER_READY_DELAY_MS = 300L
    private const val FLOW_CREDIT_TIMEOUT_MS = 1_500L
    private const val PRINT_RASTER_PROCESSING_DELAY_MS = 2_000L
    private const val PRINT_DISPATCH_SETTLE_MS = 1_500L
    private const val GATT_RECONNECT_DELAY_MS = 250L
    private const val DEFAULT_PACKET_BYTES = 20
    private const val ZLIB_BLOCK_SIZE = 1_024
    private const val FALLBACK_FLOW_CREDITS = 1_000

    // 12 mm at 203 dpi is approximately 96 thermal dots across.
    private const val LABEL_WIDTH_DOTS = 96
    private const val LABEL_PADDING_X = 4
    private const val LABEL_PADDING_Y = 6
    private const val MIN_LABEL_HEIGHT = 112
  }
}