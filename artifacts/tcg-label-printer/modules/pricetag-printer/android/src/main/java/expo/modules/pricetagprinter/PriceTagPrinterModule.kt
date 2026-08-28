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
import android.graphics.Matrix
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
 * BLE bitmap transport for the 203 DPI NIIMBOT D11.
 *
 * The D11 uses the Niimbot V3 packet protocol rather than ESC/POS or the
 * PrintMaster protocol used by the former N12 printer. Jobs are encoded as
 * framed page and 1-bit bitmap-row commands sent over a write-without-response
 * characteristic. Printer status arrives over notifications on the same GATT
 * characteristic when the device provides it.
 */
class PriceTagPrinterModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())
  private val stateLock = Any()
  private val printMutex = Mutex()

  private var gatt: BluetoothGatt? = null
  private var printerCharacteristic: BluetoothGattCharacteristic? = null
  private var connectedAddress: String? = null
  private var negotiatedMtu = DEFAULT_ATT_MTU
  private var statusNotificationsEnabled = false
  private var statusNotificationSetupPending = false
  private var notificationBuffer = byteArrayOf()
  private var lastD11StatusPage: Int? = null
  private val printRejection = D11PrintRejectionLatch()
  private var connectionAttemptId = 0L
  private var reservedConnectionAttemptId: Long? = null
  private var pendingConnectionAttemptId: Long? = null
  private var connectionContinuation: CancellableContinuation<Map<String, String>>? = null
  private var statusContinuation: CancellableContinuation<Int>? = null

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
        closeConnection(IOException("D11_CONNECTION_CANCELLED: The NIIMBOT D11 connection was cancelled."))
      }
    }

    AsyncFunction("getConnectionStateAsync") {
      synchronized(stateLock) {
        mapOf(
          "connected" to (gatt != null && printerCharacteristic != null),
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
      manager.askForPermissions(PermissionsResponseListener {
        if (continuation.isActive) continuation.resume(getPermissionStatus())
      }, *permissions)
    }
  }

  private fun requireBluetoothPermission() {
    if (getPermissionStatus()["granted"] != true) {
      throw IllegalStateException(
        "BLUETOOTH_PERMISSION_REQUIRED: Allow Nearby devices access to find and connect to the NIIMBOT D11."
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
      ?: throw IllegalStateException("BLE_UNAVAILABLE: This Android device cannot scan for the NIIMBOT D11.")
    val devices = Collections.synchronizedMap(linkedMapOf<String, Map<String, String>>())

    // The D11 may stop advertising after Android pairs with it. Include bonded
    // devices so that selecting it again does not require removing the pairing.
    adapter.bondedDevices.forEach { device ->
      devices[device.address] = deviceToMap(device)
    }

    return suspendCancellableCoroutine { continuation ->
      val callback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
          result.device?.let { device -> devices[device.address] = deviceToMap(device) }
        }

        override fun onScanFailed(errorCode: Int) {
          if (continuation.isActive) {
            continuation.resumeWithException(
              IllegalStateException(
                "D11_SCAN_FAILED: Android could not scan for nearby printers (error $errorCode)."
              )
            )
          }
        }
      }

      try {
        scanner.startScan(callback)
      } catch (error: SecurityException) {
        continuation.resumeWithException(
          IllegalStateException(
            "BLUETOOTH_PERMISSION_REQUIRED: Allow Nearby devices access to find the NIIMBOT D11.",
            error
          )
        )
        return@suspendCancellableCoroutine
      }

      val finishScan = Runnable {
        try {
          scanner.stopScan(callback)
        } catch (_: SecurityException) {
          // The permission error is surfaced when a scan is started.
        }
        if (continuation.isActive) {
          val discovered = synchronized(devices) {
            devices.values.sortedWith(
              compareByDescending<Map<String, String>> { device ->
                device["name"]?.startsWith("D11", ignoreCase = true) == true
              }.thenByDescending { device ->
                device["name"]?.startsWith("D1", ignoreCase = true) == true
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
          // Nothing else to release.
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
      throw IllegalArgumentException(
        "PRINTER_ADDRESS_REQUIRED: Choose your nearby NIIMBOT D11 in Settings before printing."
      )
    }

    // Android can retain a GATT object after a sleeping printer drops its radio
    // link. Verify the system state before treating the existing session as live.
    val looksConnected = synchronized(stateLock) {
      gatt != null && printerCharacteristic != null && connectedAddress == normalizedAddress
    }
    if (looksConnected) {
      val manager = appContext.reactContext?.applicationContext
        ?.getSystemService(android.content.Context.BLUETOOTH_SERVICE) as? android.bluetooth.BluetoothManager
      val device = try {
        BluetoothAdapter.getDefaultAdapter()?.getRemoteDevice(normalizedAddress)
      } catch (_: Throwable) {
        null
      }
      val actuallyConnected = device != null &&
        manager?.getConnectionState(device, BluetoothProfile.GATT) == BluetoothProfile.STATE_CONNECTED
      if (actuallyConnected) {
        return mapOf("name" to "NIIMBOT D11", "address" to normalizedAddress)
      }
      closeConnection(
        IOException("D11_DISCONNECTED: The NIIMBOT D11 disconnected. Wake it and reconnect before printing.")
      )
    }

    val connectionAttempt = synchronized(stateLock) {
      if (reservedConnectionAttemptId != null || connectionContinuation != null) {
        throw IllegalStateException(
          "D11_CONNECTION_IN_PROGRESS: Wait for the current NIIMBOT D11 connection attempt to finish."
        )
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
      throw IllegalArgumentException(
        "D11_ADDRESS_INVALID: Select the NIIMBOT D11 from the nearby-printer list.",
        error
      )
    }

    if (connectionAttempt.second) {
      closeConnection(
        IOException("D11_CONNECTION_REPLACED: The previous printer connection was closed to start a new one."),
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
            IOException("D11_CONNECTION_CANCELLED: The NIIMBOT D11 connection attempt was cancelled.")
          )
          return@suspendCancellableCoroutine
        }
        val context = appContext.reactContext?.applicationContext
        if (context == null) {
          clearConnectionAttempt(continuation, attemptId)
          continuation.resumeWithException(
            IllegalStateException("D11_CONNECTION_UNAVAILABLE: Android could not create a Bluetooth connection.")
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
            IllegalStateException(
              "BLUETOOTH_PERMISSION_REQUIRED: Allow Nearby devices access to connect to the NIIMBOT D11.",
              error
            )
          )
          return@suspendCancellableCoroutine
        }
        if (createdGatt == null) {
          clearConnectionAttempt(continuation, attemptId)
          continuation.resumeWithException(
            IOException("D11_CONNECTION_FAILED: Android could not open a Bluetooth connection to the selected printer.")
          )
        } else {
          val shouldClose = synchronized(stateLock) {
            if (pendingConnectionAttemptId == attemptId && gatt == null) {
              gatt = createdGatt
              false
            } else {
              gatt !== createdGatt
            }
          }
          if (shouldClose) {
            try {
              createdGatt.disconnect()
              createdGatt.close()
            } catch (_: SecurityException) {
              // This attempt is already being cleaned up.
            }
          }
        }
        continuation.invokeOnCancellation { closeConnection() }
      }
    }
    return connection ?: run {
      closeConnection()
      throw IOException(
        "D11_CONNECTION_TIMED_OUT: The NIIMBOT D11 did not finish connecting. Wake it and try again."
      )
    }
  }

  private suspend fun printLabel(payload: Map<String, Any?>): Map<String, Any?> {
    if (!printMutex.tryLock()) {
      throw IllegalStateException(
        "D11_PRINT_IN_PROGRESS: Wait for the current NIIMBOT D11 label to finish before sending another."
      )
    }
    try {
      val lines = (payload["lines"] as? List<*>)
        ?.mapNotNull { it as? String }
        ?.filter { it.isNotBlank() }
        ?: emptyList()
      if (lines.isEmpty()) {
        throw IllegalArgumentException("D11_LABEL_EMPTY: This label has no printable fields.")
      }
      val hasConnection = synchronized(stateLock) { gatt != null && printerCharacteristic != null }
      if (!hasConnection) {
        throw IllegalStateException(
          "PRINTER_NOT_CONNECTED: Select and connect your NIIMBOT D11 before printing."
        )
      }

      val job = createD11PrintJob(lines)
      synchronized(stateLock) {
        printRejection.reset()
        lastD11StatusPage = null
      }
      job.frames.forEach { frame ->
        queueD11Write(frame)
        throwIfD11PrintRejected()
        delay(PACKET_DELAY_MS)
      }
      throwIfD11PrintRejected()

      val canRequestStatus = synchronized(stateLock) { statusNotificationsEnabled }
      var statusPacketsQueued = 0
      var receivedStatus = false
      var completedPageCount: Int? = null
      if (canRequestStatus) {
        for (attempt in 0 until PRINT_STATUS_ATTEMPTS) {
          throwIfD11PrintRejected()
          statusPacketsQueued += 1
          val page = requestD11PrintStatus()
          throwIfD11PrintRejected()
          if (page != null) {
            receivedStatus = true
            completedPageCount = page
            if (page >= 1) break
          }
          delay(PRINT_STATUS_POLL_DELAY_MS)
        }
      }

      // The D11 task is explicitly closed even when status notifications are
      // unavailable. The returned delivery object tells JS which confirmation
      // was available instead of mistaking a no-response write for a printer ACK.
      queueD11Write(buildD11Frame(CMD_PRINT_END, byteArrayOf(0x01)))
      if (canRequestStatus) {
        statusPacketsQueued += 1
        val terminalPage = requestD11PrintStatus()
        throwIfD11PrintRejected()
        if (terminalPage != null) {
          receivedStatus = true
          completedPageCount = terminalPage
        }
      }
      delay(PRINT_DISPATCH_SETTLE_MS)
      throwIfD11PrintRejected()
      return D11Protocol.deliveryMetadata(
        packetCount = job.frames.size + statusPacketsQueued + 1,
        packetBytes = job.maxFrameBytes,
        statusReceived = receivedStatus,
        completedPageCount = completedPageCount,
      )
    } finally {
      printMutex.unlock()
    }
  }

  private fun createD11PrintJob(lines: List<String>): D11PrintJob {
    val bitmap = renderLabel(lines)
    val frames = mutableListOf<ByteArray>()
    frames += D11Protocol.preflightFrames(bitmap.width, bitmap.height)

    for (row in 0 until bitmap.height) {
      val rowBytes = packD11BitmapRow(bitmap, row)
      if (rowBytes.all { it.toInt() == 0 }) {
        frames += buildD11Frame(CMD_PRINT_EMPTY_ROW, u16(row) + byteArrayOf(0x01))
      } else {
        val counts = ByteArray(3) { group ->
          val start = group * 4
          var count = 0
          for (index in start until start + 4) {
            count += Integer.bitCount(rowBytes[index].toInt() and 0xFF)
          }
          count.toByte()
        }
        frames += buildD11Frame(
          CMD_PRINT_BITMAP_ROW,
          u16(row) + counts + byteArrayOf(0x01) + rowBytes
        )
      }
    }
    frames += buildD11Frame(CMD_PAGE_END, byteArrayOf(0x01))
    return D11PrintJob(frames, frames.maxOf { it.size })
  }

  private fun renderLabel(lines: List<String>): Bitmap {
    /*
     * The D11 consumes one bitmap row across the 96-dot print head and advances
     * the tape for each row. Render the label in its natural landscape
     * orientation first, then rotate it counter-clockwise into that transport
     * coordinate system. Android's positive 90° transform reverses the D11
     * reading direction, so the first character must lead the feed instead.
     */
    val logicalBitmap = Bitmap.createBitmap(
      LABEL_LENGTH_DOTS,
      LABEL_WIDTH_DOTS,
      Bitmap.Config.ARGB_8888
    )
    val canvas = Canvas(logicalBitmap)
    canvas.drawColor(Color.WHITE)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.BLACK
    }
    val maxWidth = LABEL_LENGTH_DOTS - (LABEL_PADDING_X * 2)
    val firstLineTypeface = android.graphics.Typeface.create(
      android.graphics.Typeface.MONOSPACE,
      android.graphics.Typeface.BOLD
    )
    val standardTypeface = android.graphics.Typeface.create(
      android.graphics.Typeface.MONOSPACE,
      android.graphics.Typeface.NORMAL
    )
    val requestedFirstLineTextSize = if (lines.size <= 7) 18f else 16f
    val requestedStandardTextSize = if (lines.size <= 7) 14f else 12f
    val lineGap = 0.5f

    paint.textSize = requestedFirstLineTextSize
    paint.typeface = firstLineTypeface
    val requestedFirstMetrics = paint.fontMetrics
    paint.textSize = requestedStandardTextSize
    paint.typeface = standardTypeface
    val requestedStandardMetrics = paint.fontMetrics
    val requestedGlyphHeight =
      (-requestedFirstMetrics.ascent + requestedFirstMetrics.descent) +
        ((lines.size - 1).coerceAtLeast(0) *
          (-requestedStandardMetrics.ascent + requestedStandardMetrics.descent))
    val availableGlyphHeight =
      LABEL_WIDTH_DOTS - (LABEL_PADDING_Y * 2) - ((lines.size - 1).coerceAtLeast(0) * lineGap)
    val typeScale = if (requestedGlyphHeight > 0f) {
      minOf(1f, availableGlyphHeight / requestedGlyphHeight)
    } else {
      1f
    }
    val firstLineTextSize = requestedFirstLineTextSize * typeScale
    val standardTextSize = requestedStandardTextSize * typeScale

    paint.textSize = firstLineTextSize
    paint.typeface = firstLineTypeface
    val firstMetrics = paint.fontMetrics
    paint.textSize = standardTextSize
    paint.typeface = standardTypeface
    val standardMetrics = paint.fontMetrics
    var baseline = LABEL_PADDING_Y.toFloat() - firstMetrics.ascent
    lines.forEachIndexed { index, line ->
      paint.textSize = if (index == 0) firstLineTextSize else standardTextSize
      paint.typeface = if (index == 0) firstLineTypeface else standardTypeface
      canvas.drawText(
        ellipsizeLine(line, paint, maxWidth),
        LABEL_PADDING_X.toFloat(),
        baseline.toFloat(),
        paint
      )
      if (index < lines.lastIndex) {
        val metrics = if (index == 0) firstMetrics else standardMetrics
        baseline += metrics.descent + lineGap - standardMetrics.ascent
      }
    }
    return Bitmap.createBitmap(
      logicalBitmap,
      0,
      0,
      logicalBitmap.width,
      logicalBitmap.height,
      Matrix().apply { postRotate(-90f) },
      true
    )
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

  /**
   * D11 bitmap rows are 96 dots / 12 bytes. A one represents a dark thermal
   * pixel, with the most-significant bit printed first in each byte.
   */
  private fun packD11BitmapRow(bitmap: Bitmap, row: Int): ByteArray {
    val bytes = ByteArray(LABEL_WIDTH_DOTS / 8)
    for (byteIndex in bytes.indices) {
      var packed = 0
      for (bit in 0 until 8) {
        val color = bitmap.getPixel((byteIndex * 8) + bit, row)
        val luminance = (
          Color.red(color) * 299 +
            Color.green(color) * 587 +
            Color.blue(color) * 114
          ) / 1000
        if (luminance < 128) packed = packed or (0x80 shr bit)
      }
      bytes[byteIndex] = packed.toByte()
    }
    return bytes
  }

  /**
   * NIIMBOT V3 stores page dimensions, row offsets, and page counters high-byte first.
   */
  private fun u16(value: Int): ByteArray = D11Protocol.u16(value)

  private fun buildD11Frame(command: Int, data: ByteArray): ByteArray =
    D11Protocol.buildFrame(command, data)

  private fun throwIfD11PrintRejected() {
    synchronized(stateLock) {
      printRejection.throwIfRejected()
    }
  }

  @SuppressLint("MissingPermission")
  private fun queueD11Write(frame: ByteArray) {
    val activeGatt: BluetoothGatt
    val characteristic: BluetoothGattCharacteristic
    val mtu: Int
    synchronized(stateLock) {
      activeGatt = gatt ?: throw IllegalStateException(
        "PRINTER_NOT_CONNECTED: Reconnect your NIIMBOT D11 before printing."
      )
      characteristic = printerCharacteristic ?: throw IllegalStateException(
        "D11_PROTOCOL_UNAVAILABLE: The selected device is not exposing the NIIMBOT D11 print service."
      )
      mtu = negotiatedMtu
    }
    if (frame.size > mtu - ATT_PROTOCOL_OVERHEAD) {
      throw IOException(
        "D11_MTU_TOO_SMALL: The NIIMBOT D11 connection cannot send a complete label row. Reconnect and try again."
      )
    }
    characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
    characteristic.value = frame
    val queued = try {
      @Suppress("DEPRECATION")
      activeGatt.writeCharacteristic(characteristic)
    } catch (error: SecurityException) {
      throw IllegalStateException(
        "BLUETOOTH_PERMISSION_REQUIRED: Allow Nearby devices access to keep printing to the NIIMBOT D11.",
        error
      )
    }
    if (!queued) {
      throw IOException(
        "D11_WRITE_FAILED: The NIIMBOT D11 did not accept a label packet. Keep it awake and reconnect."
      )
    }
  }

  private suspend fun requestD11PrintStatus(): Int? {
    if (!synchronized(stateLock) { statusNotificationsEnabled }) return null
    return withTimeoutOrNull(STATUS_RESPONSE_TIMEOUT_MS) {
      suspendCancellableCoroutine { continuation ->
        val canRequest = synchronized(stateLock) {
          if (statusContinuation != null) {
            false
          } else {
            statusContinuation = continuation
            true
          }
        }
        if (!canRequest) {
          continuation.resumeWithException(
            IllegalStateException("D11_STATUS_IN_PROGRESS: Wait for the current NIIMBOT D11 status check.")
          )
          return@suspendCancellableCoroutine
        }
        try {
          queueD11Write(buildD11Frame(CMD_PRINT_STATUS, byteArrayOf(0x01)))
        } catch (error: Throwable) {
          synchronized(stateLock) {
            if (statusContinuation === continuation) statusContinuation = null
          }
          continuation.resumeWithException(error)
          return@suspendCancellableCoroutine
        }
        continuation.invokeOnCancellation {
          synchronized(stateLock) {
            if (statusContinuation === continuation) statusContinuation = null
          }
        }
      }
    }
  }

  private fun createGattCallback(attemptId: Long) = object : BluetoothGattCallback() {
    override fun onConnectionStateChange(activeGatt: BluetoothGatt, status: Int, newState: Int) {
      if (!isCurrentGatt(activeGatt, attemptId)) return
      if (status != BluetoothGatt.GATT_SUCCESS) {
        closeConnection(
          activeGatt,
          IOException("D11_CONNECTION_FAILED: The NIIMBOT D11 disconnected during setup (status $status).")
        )
        return
      }
      if (newState == BluetoothProfile.STATE_CONNECTED) {
        if (!activeGatt.discoverServices()) {
          closeConnection(
            activeGatt,
            IOException("D11_SERVICE_DISCOVERY_FAILED: Android could not inspect the NIIMBOT D11 print service.")
          )
        }
      } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
        closeConnection(
          activeGatt,
          IOException("D11_DISCONNECTED: The NIIMBOT D11 disconnected. Wake it and reconnect before printing.")
        )
      }
    }

    override fun onServicesDiscovered(activeGatt: BluetoothGatt, status: Int) {
      if (!isCurrentGatt(activeGatt, attemptId)) return
      if (status != BluetoothGatt.GATT_SUCCESS) {
        closeConnection(
          activeGatt,
          IOException("D11_SERVICE_DISCOVERY_FAILED: Android could not inspect the NIIMBOT D11 print service.")
        )
        return
      }
      val service = activeGatt.getService(D11_SERVICE_UUID)
      val output = service?.getCharacteristic(D11_CHARACTERISTIC_UUID)
      if (output == null) {
        closeConnection(
          activeGatt,
          IllegalStateException(
            "D11_PROTOCOL_UNAVAILABLE: The selected device is not a compatible NIIMBOT D11 printer."
          )
        )
        return
      }
      val supportsNoResponse = (
        output.properties and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE
        ) != 0
      if (!supportsNoResponse) {
        closeConnection(
          activeGatt,
          IllegalStateException(
            "D11_PROTOCOL_UNAVAILABLE: The NIIMBOT D11 print service does not allow label writes."
          )
        )
        return
      }
      val canEnableStatusNotifications = (
        output.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY
        ) != 0 && output.getDescriptor(CLIENT_CHARACTERISTIC_CONFIG_UUID) != null
      synchronized(stateLock) {
        printerCharacteristic = output
        negotiatedMtu = DEFAULT_ATT_MTU
        notificationBuffer = byteArrayOf()
        lastD11StatusPage = null
        statusNotificationsEnabled = false
        statusNotificationSetupPending = canEnableStatusNotifications
      }
      val notificationWriteQueued = canEnableStatusNotifications &&
        enableStatusNotifications(activeGatt, output)
      if (!notificationWriteQueued) {
        synchronized(stateLock) {
          statusNotificationSetupPending = false
        }
        requestD11Mtu(activeGatt)
      }
    }

    @SuppressLint("MissingPermission")
    override fun onDescriptorWrite(
      activeGatt: BluetoothGatt,
      descriptor: BluetoothGattDescriptor,
      status: Int
    ) {
      if (!isCurrentGatt(activeGatt, attemptId) ||
        descriptor.uuid != CLIENT_CHARACTERISTIC_CONFIG_UUID
      ) return
      val shouldRequestMtu = synchronized(stateLock) {
        if (!statusNotificationSetupPending) {
          false
        } else {
          statusNotificationSetupPending = false
          statusNotificationsEnabled = status == BluetoothGatt.GATT_SUCCESS
          true
        }
      }
      if (shouldRequestMtu) requestD11Mtu(activeGatt)
    }

    override fun onMtuChanged(activeGatt: BluetoothGatt, mtu: Int, status: Int) {
      if (!isCurrentGatt(activeGatt, attemptId)) return
      if (status != BluetoothGatt.GATT_SUCCESS || mtu < MINIMUM_D11_MTU) {
        closeConnection(
          activeGatt,
          IOException(
            "D11_MTU_TOO_SMALL: The NIIMBOT D11 needs a larger Bluetooth packet size for labels. Reconnect and try again."
          )
        )
        return
      }
      val output = synchronized(stateLock) {
        negotiatedMtu = mtu
        printerCharacteristic
      } ?: return
      try {
        queueD11Write(buildD11Frame(CMD_CONNECT, byteArrayOf(0x01)))
      } catch (error: Throwable) {
        closeConnection(activeGatt, error)
        return
      }
      scheduleConnectionCompletion(activeGatt, attemptId, PRINTER_READY_DELAY_MS)
    }

    override fun onCharacteristicChanged(
      activeGatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      value: ByteArray
    ) {
      handleD11Notification(activeGatt, attemptId, characteristic, value)
    }

    @Suppress("DEPRECATION")
    override fun onCharacteristicChanged(
      activeGatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic
    ) {
      handleD11Notification(
        activeGatt,
        attemptId,
        characteristic,
        characteristic.value ?: byteArrayOf()
      )
    }
  }

  @SuppressLint("MissingPermission")
  private fun enableStatusNotifications(
    activeGatt: BluetoothGatt,
    characteristic: BluetoothGattCharacteristic
  ): Boolean {
    if (characteristic.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY == 0) return false
    if (!activeGatt.setCharacteristicNotification(characteristic, true)) return false
    val descriptor = characteristic.getDescriptor(CLIENT_CHARACTERISTIC_CONFIG_UUID) ?: return false
    descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
    return try {
      @Suppress("DEPRECATION")
      activeGatt.writeDescriptor(descriptor)
    } catch (_: SecurityException) {
      false
    }
  }

  @SuppressLint("MissingPermission")
  private fun requestD11Mtu(activeGatt: BluetoothGatt) {
    if (synchronized(stateLock) { gatt !== activeGatt }) return
    if (!activeGatt.requestMtu(D11_REQUESTED_MTU)) {
      closeConnection(
        activeGatt,
        IOException("D11_MTU_NEGOTIATION_FAILED: Android could not prepare the NIIMBOT D11 for label data.")
      )
    }
  }

  private fun handleD11Notification(
    activeGatt: BluetoothGatt,
    attemptId: Long,
    characteristic: BluetoothGattCharacteristic,
    incoming: ByteArray
  ) {
    if (!isCurrentGatt(activeGatt, attemptId) || characteristic.uuid != D11_CHARACTERISTIC_UUID) return
    val frames = synchronized(stateLock) {
      notificationBuffer += incoming
      val parsed = mutableListOf<D11Response>()
      while (notificationBuffer.size >= MIN_D11_FRAME_SIZE) {
        var head = -1
        for (index in 0 until notificationBuffer.size - 1) {
          if (notificationBuffer[index] == FRAME_HEAD && notificationBuffer[index + 1] == FRAME_HEAD) {
            head = index
            break
          }
        }
        if (head < 0) {
          notificationBuffer = notificationBuffer.takeLast(1).toByteArray()
          break
        }
        if (head > 0) notificationBuffer = notificationBuffer.copyOfRange(head, notificationBuffer.size)
        if (notificationBuffer.size < MIN_D11_FRAME_SIZE) break
        val dataLength = notificationBuffer[3].toInt() and 0xFF
        val frameSize = MIN_D11_FRAME_SIZE + dataLength
        if (notificationBuffer.size < frameSize) break
        val frame = notificationBuffer.copyOfRange(0, frameSize)
        notificationBuffer = notificationBuffer.copyOfRange(frameSize, notificationBuffer.size)
        val expectedChecksumIndex = 4 + dataLength
        var checksum = (frame[2].toInt() and 0xFF) xor dataLength
        for (index in 0 until dataLength) checksum = checksum xor (frame[4 + index].toInt() and 0xFF)
        if (
          frame[frameSize - 2] != FRAME_TAIL ||
          frame[frameSize - 1] != FRAME_TAIL ||
          (frame[expectedChecksumIndex].toInt() and 0xFF) != checksum
        ) {
          continue
        }
        parsed += D11Response(
          command = frame[2].toInt() and 0xFF,
          data = frame.copyOfRange(4, 4 + dataLength)
        )
      }
      parsed
    }
    frames.forEach { response ->
      if (response.command == RESP_PRINT_STATUS && response.data.size >= 2) {
        val page = ((response.data[0].toInt() and 0xFF) shl 8) or
          (response.data[1].toInt() and 0xFF)
        val continuation = synchronized(stateLock) {
          lastD11StatusPage = page
          statusContinuation.also { statusContinuation = null }
        }
        if (continuation?.isActive == true) continuation.resume(page)
      } else if (response.command == RESP_PRINT_ERROR) {
        val (error, statusWaiter) = synchronized(stateLock) {
          val error = printRejection.reject()
          val statusWaiter = statusContinuation
          statusContinuation = null
          Pair(error, statusWaiter)
        }
        if (statusWaiter?.isActive == true) {
          statusWaiter.resumeWithException(error)
        }
      }
    }
  }

  private fun scheduleConnectionCompletion(
    activeGatt: BluetoothGatt,
    attemptId: Long,
    delayMs: Long
  ) {
    mainHandler.postDelayed({
      val canComplete = synchronized(stateLock) {
        gatt === activeGatt &&
          pendingConnectionAttemptId == attemptId &&
          connectionContinuation != null
      }
      if (canComplete) completeConnection(activeGatt)
    }, delayMs)
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
      continuation.resume(mapOf("name" to "NIIMBOT D11", "address" to address))
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
      if (reservedConnectionAttemptId == attemptId) reservedConnectionAttemptId = null
    }
  }

  private fun closeConnection(
    reason: Throwable? = null,
    preserveConnectionReservation: Boolean = false
  ) {
    closeConnection(null, reason, preserveConnectionReservation)
  }

  private fun closeConnection(
    expectedGatt: BluetoothGatt?,
    reason: Throwable?,
    preserveConnectionReservation: Boolean = false
  ) {
    val toFailConnection: CancellableContinuation<Map<String, String>>?
    val toFailStatus: CancellableContinuation<Int>?
    val activeGatt: BluetoothGatt?
    synchronized(stateLock) {
      if (expectedGatt != null && gatt !== expectedGatt) return
      toFailConnection = connectionContinuation
      toFailStatus = statusContinuation
      connectionContinuation = null
      statusContinuation = null
      pendingConnectionAttemptId = null
      if (!preserveConnectionReservation) reservedConnectionAttemptId = null
      activeGatt = gatt
      gatt = null
      printerCharacteristic = null
      connectedAddress = null
      negotiatedMtu = DEFAULT_ATT_MTU
      statusNotificationsEnabled = false
      statusNotificationSetupPending = false
      notificationBuffer = byteArrayOf()
      lastD11StatusPage = null
    }
    try {
      activeGatt?.disconnect()
      activeGatt?.close()
    } catch (_: SecurityException) {
      // Android is already releasing the Bluetooth session.
    }
    if (reason != null) {
      if (toFailConnection?.isActive == true) toFailConnection.resumeWithException(reason)
      if (toFailStatus?.isActive == true) toFailStatus.resumeWithException(reason)
    }
  }

  private data class D11PrintJob(
    val frames: List<ByteArray>,
    val maxFrameBytes: Int
  )

  private data class D11Response(
    val command: Int,
    val data: ByteArray
  )

  companion object {
    private val D11_SERVICE_UUID: UUID = UUID.fromString("e7810a71-73ae-499d-8c15-faa9aef0c3f2")
    private val D11_CHARACTERISTIC_UUID: UUID = UUID.fromString("bef8d6c9-9c21-4c9e-b632-bd58c1009f9f")
    private val CLIENT_CHARACTERISTIC_CONFIG_UUID: UUID =
      UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

    private const val FRAME_HEAD: Byte = 0x55
    private const val FRAME_TAIL: Byte = 0xAA.toByte()
    private const val CMD_CONNECT = 0xC1
    private const val CMD_PRINT_BITMAP_ROW = 0x85
    private const val CMD_PRINT_EMPTY_ROW = 0x84
    private const val CMD_PRINT_STATUS = 0xA3
    private const val CMD_PAGE_END = 0xE3
    private const val CMD_PRINT_END = 0xF3
    private const val RESP_PRINT_STATUS = 0xB3
    private const val RESP_PRINT_ERROR = 0xDB

    private const val SCAN_DURATION_MS = 6_000L
    private const val CONNECTION_TIMEOUT_MS = 12_000L
    private const val PRINTER_READY_DELAY_MS = 250L
    private const val PACKET_DELAY_MS = 8L
    private const val STATUS_RESPONSE_TIMEOUT_MS = 900L
    private const val PRINT_STATUS_POLL_DELAY_MS = 120L
    private const val PRINT_STATUS_ATTEMPTS = 5
    private const val PRINT_DISPATCH_SETTLE_MS = 350L
    private const val GATT_RECONNECT_DELAY_MS = 250L
    private const val DEFAULT_ATT_MTU = 23
    private const val D11_REQUESTED_MTU = 247
    private const val MINIMUM_D11_MTU = 32
    private const val ATT_PROTOCOL_OVERHEAD = 3
    private const val MIN_D11_FRAME_SIZE = 7
    // 12 mm at the D11's 203 DPI print head is approximately 96 thermal dots.
    private const val LABEL_WIDTH_DOTS = 96
    // ~50 mm of printable length gives the card details a landscape layout.
    private const val LABEL_LENGTH_DOTS = 400
    private const val LABEL_PADDING_X = 4
    private const val LABEL_PADDING_Y = 6
  }
}