package expo.modules.pricetagprinter

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothSocket
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
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
 * Bitmap transport for the 203 DPI NIIMBOT D11.
 *
 * The D11 uses the Niimbot V3 packet protocol rather than ESC/POS or the
 * PrintMaster protocol used by the former N12 printer. Jobs are encoded as
 * framed page and 1-bit bitmap-row commands sent over the printer's classic
 * RFCOMM serial channel. BLE remains useful for discovery, but RFCOMM avoids
 * the GATT MTU limit that otherwise truncates 25-byte bitmap-row frames.
 */
class PriceTagPrinterModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())
  private val stateLock = Any()
  private val printMutex = Mutex()

  private var gatt: BluetoothGatt? = null
  private var printerCharacteristic: BluetoothGattCharacteristic? = null
  private var classicSocket: BluetoothSocket? = null
  private var connectedAddress: String? = null
  private var negotiatedMtu = DEFAULT_ATT_MTU
  private var statusNotificationsEnabled = false
  private var notificationBuffer = byteArrayOf()
  private var serialResponseBuffer = byteArrayOf()
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
          "connected" to (classicSocket?.isConnected == true),
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
      if (isD11Device(device)) {
        devices[device.address] = deviceToMap(device)
      }
    }

    return suspendCancellableCoroutine { continuation ->
      val callback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
          result.device?.let { device ->
            if (isD11Device(device)) devices[device.address] = deviceToMap(device)
          }
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
            devices.values.sortedBy { device -> device["name"]?.lowercase() ?: "" }
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
  private fun isD11Device(device: BluetoothDevice): Boolean =
    D11Protocol.isD11DeviceName(device.name)

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

    val existingSocket = synchronized(stateLock) {
      classicSocket?.takeIf { it.isConnected && connectedAddress == normalizedAddress }
    }
    if (existingSocket != null) {
      return mapOf("name" to "NIIMBOT D11", "address" to normalizedAddress)
    }

    closeConnection()
    val adapter = bluetoothAdapter()
    adapter.cancelDiscovery()
    var lastFailure: Throwable? = null
    for (candidateAddress in classicAddressCandidates(adapter, normalizedAddress)) {
      val device = try {
        adapter.getRemoteDevice(candidateAddress)
      } catch (error: IllegalArgumentException) {
        lastFailure = error
        continue
      }
      val socketFactories = listOf<() -> BluetoothSocket>(
        { device.createInsecureRfcommSocketToServiceRecord(SERIAL_PORT_PROFILE_UUID) },
        { device.createRfcommSocketToServiceRecord(SERIAL_PORT_PROFILE_UUID) },
      )
      for (createSocket in socketFactories) {
        val socket = try {
          createSocket()
        } catch (error: Throwable) {
          lastFailure = error
          continue
        }
        try {
          socket.connect()
          synchronized(stateLock) {
            classicSocket = socket
            connectedAddress = normalizedAddress
            statusNotificationsEnabled = false
          }
          return mapOf(
            "name" to (device.name ?: "NIIMBOT D11"),
            "address" to normalizedAddress,
          )
        } catch (error: Throwable) {
          lastFailure = error
          try {
            socket.close()
          } catch (_: IOException) {
            // Continue with the next classic D11 address/socket mode.
          }
        }
      }
    }
    throw IOException(
      "D11_CLASSIC_CONNECTION_FAILED: Pair the NIIMBOT D11 in Android Bluetooth settings, keep it awake, then reconnect in PriceTag.",
      lastFailure,
    )
  }

  @SuppressLint("MissingPermission")
  private fun classicAddressCandidates(
    adapter: BluetoothAdapter,
    discoveredAddress: String,
  ): List<String> {
    val candidates = linkedSetOf<String>()
    adapter.bondedDevices
      .filter { isD11Device(it) && it.type != BluetoothDevice.DEVICE_TYPE_LE }
      .forEach { candidates += it.address.uppercase() }
    D11Protocol.classicAddressForBle(discoveredAddress)?.let { candidates += it }
    candidates += discoveredAddress
    return candidates.toList()
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
      val barcode = payload["barcode"] as? String
      val showBarcode = payload["showBarcode"] as? Boolean ?: false
      val showLogo = payload["showLogo"] as? Boolean ?: false
      val showWebsite = payload["showWebsite"] as? Boolean ?: false
      val content = LabelContent(
        cardName = payload["cardName"] as? String ?: lines.first(),
        series = payload["series"] as? String ?: lines.getOrNull(1).orEmpty(),
        price = payload["price"] as? String ?: "",
        condition = payload["condition"] as? String ?: lines.getOrNull(2).orEmpty(),
        generatedAt = payload["generatedAt"] as? String ?: "",
        stale = payload["stale"] as? Boolean ?: false,
        barcode = barcode,
        showBarcode = showBarcode,
        showLogo = showLogo,
        showWebsite = showWebsite,
      )
      if (lines.isEmpty()) {
        throw IllegalArgumentException("D11_LABEL_EMPTY: This label has no printable fields.")
      }
      val hasConnection = synchronized(stateLock) { classicSocket?.isConnected == true }
      if (!hasConnection) {
        throw IllegalStateException(
          "PRINTER_NOT_CONNECTED: Select and connect your NIIMBOT D11 before printing."
        )
      }

      val job = createD11PrintJob(content)
      synchronized(stateLock) {
        printRejection.reset()
        lastD11StatusPage = null
        serialResponseBuffer = byteArrayOf()
      }
      job.frames.forEachIndexed { index, frame ->
        val command = D11Protocol.command(frame)
        if (index < job.preflightFrameCount || command == CMD_PAGE_END) {
          sendD11CommandAndAwait(frame, D11Protocol.expectedResponseCommand(command))
        } else {
          queueD11Write(frame)
        }
        throwIfD11PrintRejected()
        delay(PACKET_DELAY_MS)
      }
      throwIfD11PrintRejected()

      delay(PRINT_END_INITIAL_DELAY_MS)
      finishD11Print()
      delay(PRINT_DISPATCH_SETTLE_MS)
      throwIfD11PrintRejected()
      return D11Protocol.deliveryMetadata(
        packetCount = job.frames.size + 1,
        packetBytes = job.maxFrameBytes,
        statusReceived = true,
        completedPageCount = 1,
      )
    } finally {
      printMutex.unlock()
    }
  }

  private fun createD11PrintJob(content: LabelContent): D11PrintJob {
    val bitmap = renderLabel(content)
    val frames = mutableListOf<ByteArray>()
    frames += D11Protocol.preflightFrames(bitmap.height, bitmap.width)

    for (row in 0 until bitmap.height) {
      frames += D11Protocol.imageRowFrame(row, packD11BitmapRow(bitmap, row))
    }
    frames += buildD11Frame(CMD_PAGE_END, byteArrayOf(0x01))
    return D11PrintJob(
      frames = frames,
      maxFrameBytes = frames.maxOf { it.size },
      preflightFrameCount = D11Protocol.preflightFrames(bitmap.height, bitmap.width).size,
    )
  }

  private suspend fun finishD11Print() {
    val deadline = System.nanoTime() + (PRINT_COMPLETION_TIMEOUT_MS * 1_000_000L)
    while (System.nanoTime() < deadline) {
      val response = sendD11CommandAndAwait(
        buildD11Frame(CMD_PRINT_END, byteArrayOf(0x01)),
        D11Protocol.expectedResponseCommand(CMD_PRINT_END),
        requireSuccessByte = false,
      )
      if (response.data.firstOrNull()?.toInt()?.and(0xFF) != 0) return
      delay(PRINT_END_RETRY_DELAY_MS)
    }
    throw IOException(
      "D11_PRINT_NOT_COMPLETED: The NIIMBOT D11 did not accept the completed label bitmap."
    )
  }

  private fun renderLabel(content: LabelContent): Bitmap {
    /*
     * The D11 consumes one bitmap row across the 96-dot print head and advances
     * the tape for each row. Render the label in its natural landscape
     * orientation first, then map every pixel counter-clockwise into that
     * transport coordinate system. Avoid Bitmap.createBitmap's filtered
     * negative-angle transform here: the D11 needs an exact opaque 96 × 400
     * raster and has printed fully blank pages from that transformed bitmap.
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
    val barcodeValue = content.barcode?.take(MAX_BARCODE_CHARS).orEmpty()
    val barcodeWidths = if (content.showBarcode && barcodeValue.isNotBlank()) {
      code128Widths(barcodeValue)
    } else {
      emptyList()
    }
    val boldTypeface = android.graphics.Typeface.create(
      android.graphics.Typeface.SANS_SERIF,
      android.graphics.Typeface.BOLD
    )
    val contentWidth = if (content.showLogo) CONTENT_WIDTH else FULL_CONTENT_WIDTH
    drawFittedText(
      canvas, paint, content.cardName.uppercase(), 5f, 1f,
      contentWidth, 23, 26f, boldTypeface,
    )
    drawFittedText(
      canvas, paint, content.series, 5f, 24f,
      contentWidth, 14, 16f, boldTypeface,
    )
    drawFittedText(
      canvas, paint, content.condition.uppercase(), 5f, 38f,
      contentWidth, 10, 12f, boldTypeface,
    )
    drawFittedText(
      canvas, paint, content.price, 5f, 48f,
      if (content.showLogo) PRICE_WIDTH else FULL_CONTENT_WIDTH, 32, 42f, boldTypeface,
    )
    paint.isFakeBoldText = false
    if (barcodeWidths.isNotEmpty()) {
      val moduleScale = (BARCODE_MAX_WIDTH / barcodeWidths.sum()).coerceIn(1, 2)
      drawBarcode(canvas, paint, barcodeWidths, BARCODE_LEFT, moduleScale)
      paint.typeface = android.graphics.Typeface.create(
        android.graphics.Typeface.MONOSPACE,
        android.graphics.Typeface.NORMAL,
      )
      paint.textSize = 7f
      canvas.drawText(barcodeValue, BARCODE_LEFT.toFloat(), 95f, paint)
    }
    if (content.showLogo) {
      drawFigureheadzLogo(canvas, paint)
    }
    paint.typeface = android.graphics.Typeface.create(
      android.graphics.Typeface.SANS_SERIF,
      android.graphics.Typeface.NORMAL,
    )
    if (content.showWebsite) {
      paint.textSize = 8f
      canvas.drawText("figureheadz.com", META_LEFT.toFloat(), 78f, paint)
      if (content.generatedAt.isNotBlank()) {
        paint.textSize = 7f
        canvas.drawText("Generated: ${content.generatedAt}", META_LEFT.toFloat(), 88f, paint)
      }
      if (content.stale) {
        paint.typeface = boldTypeface
        paint.textSize = 7f
        canvas.drawText("STALE PRICE", META_LEFT.toFloat(), 95f, paint)
      }
    }
    val transportBitmap = Bitmap.createBitmap(
      LABEL_WIDTH_DOTS,
      LABEL_LENGTH_DOTS,
      Bitmap.Config.ARGB_8888
    )
    for (logicalY in 0 until logicalBitmap.height) {
      for (logicalX in 0 until logicalBitmap.width) {
        val (transportX, transportY) = D11Protocol.counterClockwiseTransportCoordinates(
          logicalX = logicalX,
          logicalY = logicalY,
          logicalWidth = logicalBitmap.width,
        )
        transportBitmap.setPixel(
          transportX,
          transportY,
          logicalBitmap.getPixel(logicalX, logicalY),
        )
      }
    }
    return transportBitmap
  }

  private fun drawFittedText(
    canvas: Canvas,
    paint: Paint,
    text: String,
    left: Float,
    top: Float,
    width: Int,
    height: Int,
    maximumSize: Float,
    typeface: android.graphics.Typeface,
  ) {
    if (text.isBlank() || width <= 0 || height <= 0) return
    paint.typeface = typeface
    paint.isFakeBoldText = true
    var low = MIN_FITTED_TEXT_SIZE
    var high = maximumSize
    repeat(FONT_FIT_ITERATIONS) {
      val candidate = (low + high) / 2f
      paint.textSize = candidate
      val metrics = paint.fontMetrics
      val fitsWidth = paint.measureText(text) <= width
      val fitsHeight = metrics.descent - metrics.ascent <= height
      if (fitsWidth && fitsHeight) low = candidate else high = candidate
    }
    paint.textSize = low
    val metrics = paint.fontMetrics
    val baseline = top + ((height - (metrics.descent - metrics.ascent)) / 2f) - metrics.ascent
    canvas.drawText(text, left, baseline, paint)
  }

  private fun drawFigureheadzLogo(canvas: Canvas, paint: Paint) {
    val burst = Path().apply {
      moveTo(309f, 35f)
      lineTo(320f, 27f)
      lineTo(315f, 15f)
      lineTo(333f, 19f)
      lineTo(341f, 5f)
      lineTo(351f, 19f)
      lineTo(369f, 10f)
      lineTo(366f, 26f)
      lineTo(386f, 31f)
      lineTo(370f, 40f)
      lineTo(380f, 53f)
      lineTo(360f, 50f)
      lineTo(350f, 65f)
      lineTo(340f, 51f)
      lineTo(321f, 60f)
      lineTo(324f, 44f)
      close()
    }
    paint.style = Paint.Style.FILL
    paint.color = Color.BLACK
    canvas.drawPath(burst, paint)
    paint.color = Color.WHITE
    paint.typeface = android.graphics.Typeface.create(
      "sans-serif-condensed",
      android.graphics.Typeface.BOLD_ITALIC,
    )
    paint.textSize = 7f
    paint.isFakeBoldText = true
    canvas.drawText("FIGUREHEADZ", 318f, 37f, paint)
    paint.isFakeBoldText = false
    paint.color = Color.BLACK
  }

  private fun drawBarcode(
    canvas: Canvas,
    paint: Paint,
    widths: List<Int>,
    startX: Int,
    moduleScale: Int,
  ) {
    var x = startX
    var isBar = true
    paint.style = Paint.Style.FILL
    paint.color = Color.BLACK
    widths.forEach { width ->
      val scaledWidth = width * moduleScale
      if (isBar) {
        canvas.drawRect(
          x.toFloat(),
          80f,
          (x + scaledWidth).toFloat(),
          90f,
          paint,
        )
      }
      x += scaledWidth
      isBar = !isBar
    }
  }

  private fun code128Widths(value: String): List<Int> {
    val symbols = CODE128_SYMBOLS
    val codes = value.mapNotNull { character ->
      character.code.takeIf { it in 32..126 }?.minus(32)
    }
    var checksum = 104
    codes.forEachIndexed { index, code -> checksum += code * (index + 1) }
    val symbolIndexes = listOf(104) + codes + listOf(checksum % 103, 106)
    return symbolIndexes.flatMap { index ->
      symbols[index].map { digit -> digit.digitToInt() }
    }
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
    val socket = synchronized(stateLock) { classicSocket }
    if (socket?.isConnected == true) {
      try {
        socket.outputStream.write(frame)
        socket.outputStream.flush()
        return
      } catch (error: IOException) {
        closeConnection(
          IOException(
            "D11_DISCONNECTED: The NIIMBOT D11 serial connection was lost. Wake it and reconnect before printing.",
            error,
          )
        )
        throw error
      }
    }
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

  private suspend fun sendD11CommandAndAwait(
    frame: ByteArray,
    expectedResponseCommand: Int,
    requireSuccessByte: Boolean = true,
  ): D11Response {
    queueD11Write(frame)
    val response = awaitSerialD11Response(expectedResponseCommand)
    if (requireSuccessByte && response.data.firstOrNull()?.toInt() == 0) {
      throw IOException(
        "D11_COMMAND_REJECTED: The NIIMBOT D11 rejected command 0x${D11Protocol.command(frame).toString(16)}."
      )
    }
    return response
  }

  private suspend fun awaitSerialD11Response(
    expectedCommand: Int,
    timeoutMs: Long = SERIAL_RESPONSE_TIMEOUT_MS,
  ): D11Response {
    val deadline = System.nanoTime() + (timeoutMs * 1_000_000L)
    while (System.nanoTime() < deadline) {
      while (true) {
        val response = pollSerialD11Response() ?: break
        if (response.command == RESP_PRINT_ERROR) {
          throw synchronized(stateLock) { printRejection.reject() }
        }
        if (response.command == expectedCommand) return response
      }
      val socket = synchronized(stateLock) { classicSocket }
        ?: throw IOException("D11_DISCONNECTED: Reconnect the NIIMBOT D11 before printing.")
      try {
        val available = socket.inputStream.available()
        if (available > 0) {
          val incoming = ByteArray(minOf(available, SERIAL_READ_BUFFER_BYTES))
          val count = socket.inputStream.read(incoming)
          if (count > 0) {
            synchronized(stateLock) {
              serialResponseBuffer += incoming.copyOf(count)
            }
            continue
          }
        }
      } catch (error: IOException) {
        closeConnection(
          IOException("D11_DISCONNECTED: The NIIMBOT D11 serial response was interrupted.", error)
        )
        throw error
      }
      delay(SERIAL_RESPONSE_POLL_MS)
    }
    throw IOException(
      "D11_RESPONSE_TIMED_OUT: The NIIMBOT D11 did not acknowledge command 0x${expectedCommand.toString(16)}."
    )
  }

  private fun pollSerialD11Response(): D11Response? =
    synchronized(stateLock) {
      while (serialResponseBuffer.size >= MIN_D11_FRAME_SIZE) {
        val head = (0 until serialResponseBuffer.size - 1).firstOrNull { index ->
          serialResponseBuffer[index] == FRAME_HEAD &&
            serialResponseBuffer[index + 1] == FRAME_HEAD
        } ?: run {
          serialResponseBuffer = serialResponseBuffer.takeLast(1).toByteArray()
          return@synchronized null
        }
        if (head > 0) {
          serialResponseBuffer = serialResponseBuffer.copyOfRange(head, serialResponseBuffer.size)
        }
        if (serialResponseBuffer.size < MIN_D11_FRAME_SIZE) return@synchronized null
        val dataLength = serialResponseBuffer[3].toInt() and 0xFF
        val frameSize = MIN_D11_FRAME_SIZE + dataLength
        if (serialResponseBuffer.size < frameSize) return@synchronized null
        val frame = serialResponseBuffer.copyOfRange(0, frameSize)
        serialResponseBuffer = serialResponseBuffer.copyOfRange(frameSize, serialResponseBuffer.size)
        var checksum = (frame[2].toInt() and 0xFF) xor dataLength
        for (index in 0 until dataLength) {
          checksum = checksum xor (frame[4 + index].toInt() and 0xFF)
        }
        if (
          frame[frameSize - 2] != FRAME_TAIL ||
          frame[frameSize - 1] != FRAME_TAIL ||
          (frame[4 + dataLength].toInt() and 0xFF) != checksum
        ) {
          continue
        }
        return@synchronized D11Response(
          command = frame[2].toInt() and 0xFF,
          data = frame.copyOfRange(4, 4 + dataLength),
        )
      }
      null
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
      synchronized(stateLock) {
        printerCharacteristic = output
        negotiatedMtu = DEFAULT_ATT_MTU
        notificationBuffer = byteArrayOf()
        lastD11StatusPage = null
        statusNotificationsEnabled = false
      }
      /*
       * A D11 bitmap row is a 25-byte protocol frame and must remain one
       * characteristic write. Request only the smallest MTU needed for that
       * frame; large MTU requests can destabilize older D11 firmware.
       */
      val mtuRequestQueued = try {
        activeGatt.requestMtu(D11_REQUESTED_MTU)
      } catch (_: SecurityException) {
        false
      }
      if (mtuRequestQueued) {
        scheduleMtuFallback(activeGatt, attemptId)
      } else {
        finishD11ConnectionSetup(activeGatt, attemptId)
      }
    }

    override fun onMtuChanged(activeGatt: BluetoothGatt, mtu: Int, status: Int) {
      if (!isCurrentGatt(activeGatt, attemptId)) return
      val shouldFinishSetup = synchronized(stateLock) {
        if (status == BluetoothGatt.GATT_SUCCESS) negotiatedMtu = mtu
        pendingConnectionAttemptId == attemptId && connectionContinuation != null
      }
      if (shouldFinishSetup) finishD11ConnectionSetup(activeGatt, attemptId)
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

  @SuppressLint("MissingPermission")
  private fun finishD11ConnectionSetup(activeGatt: BluetoothGatt, attemptId: Long) {
    val canFinish = synchronized(stateLock) {
      gatt === activeGatt &&
        pendingConnectionAttemptId == attemptId &&
        connectionContinuation != null
    }
    if (!canFinish) return
    try {
      queueD11Write(buildD11Frame(CMD_CONNECT, byteArrayOf(0x01)))
    } catch (error: Throwable) {
      closeConnection(activeGatt, error)
      return
    }
    scheduleConnectionCompletion(activeGatt, attemptId, PRINTER_READY_DELAY_MS)
  }

  private fun scheduleMtuFallback(activeGatt: BluetoothGatt, attemptId: Long) {
    mainHandler.postDelayed({
      finishD11ConnectionSetup(activeGatt, attemptId)
    }, MTU_CALLBACK_FALLBACK_MS)
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
    val activeSocket: BluetoothSocket?
    synchronized(stateLock) {
      if (expectedGatt != null && gatt !== expectedGatt) return
      toFailConnection = connectionContinuation
      toFailStatus = statusContinuation
      connectionContinuation = null
      statusContinuation = null
      pendingConnectionAttemptId = null
      if (!preserveConnectionReservation) reservedConnectionAttemptId = null
      activeGatt = gatt
      activeSocket = classicSocket
      gatt = null
      classicSocket = null
      printerCharacteristic = null
      connectedAddress = null
      negotiatedMtu = DEFAULT_ATT_MTU
      statusNotificationsEnabled = false
      notificationBuffer = byteArrayOf()
      serialResponseBuffer = byteArrayOf()
      lastD11StatusPage = null
    }
    try {
      activeGatt?.disconnect()
      activeGatt?.close()
    } catch (_: SecurityException) {
      // Android is already releasing the Bluetooth session.
    }
    try {
      activeSocket?.close()
    } catch (_: IOException) {
      // Android is already releasing the serial session.
    }
    if (reason != null) {
      if (toFailConnection?.isActive == true) toFailConnection.resumeWithException(reason)
      if (toFailStatus?.isActive == true) toFailStatus.resumeWithException(reason)
    }
  }

  private data class D11PrintJob(
    val frames: List<ByteArray>,
    val maxFrameBytes: Int,
    val preflightFrameCount: Int,
  )

  private data class LabelContent(
    val cardName: String,
    val series: String,
    val price: String,
    val condition: String,
    val generatedAt: String,
    val stale: Boolean,
    val barcode: String?,
    val showBarcode: Boolean,
    val showLogo: Boolean,
    val showWebsite: Boolean,
  )

  private data class D11Response(
    val command: Int,
    val data: ByteArray
  )

  companion object {
    private val D11_SERVICE_UUID: UUID = UUID.fromString("e7810a71-73ae-499d-8c15-faa9aef0c3f2")
    private val D11_CHARACTERISTIC_UUID: UUID = UUID.fromString("bef8d6c9-9c21-4c9e-b632-bd58c1009f9f")
    private val SERIAL_PORT_PROFILE_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805f9b34fb")
    private const val FRAME_HEAD: Byte = 0x55
    private const val FRAME_TAIL: Byte = 0xAA.toByte()
    private const val CMD_CONNECT = 0xC1
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
    private const val SERIAL_RESPONSE_TIMEOUT_MS = 1_500L
    private const val PRINT_COMPLETION_TIMEOUT_MS = 15_000L
    private const val PRINT_END_INITIAL_DELAY_MS = 300L
    private const val PRINT_END_RETRY_DELAY_MS = 100L
    private const val SERIAL_RESPONSE_POLL_MS = 10L
    private const val SERIAL_READ_BUFFER_BYTES = 1024
    private const val PRINT_DISPATCH_SETTLE_MS = 350L
    private const val GATT_RECONNECT_DELAY_MS = 250L
    private const val DEFAULT_ATT_MTU = 23
    private const val D11_REQUESTED_MTU = 32
    private const val MTU_CALLBACK_FALLBACK_MS = 750L
    private const val ATT_PROTOCOL_OVERHEAD = 3
    private const val MIN_D11_FRAME_SIZE = 7
    // 12 mm at the D11's 203 DPI print head is approximately 96 thermal dots.
    private const val LABEL_WIDTH_DOTS = 96
    // ~50 mm of printable length gives the card details a landscape layout.
    private const val LABEL_LENGTH_DOTS = 400
    private const val LABEL_PADDING_X = 4
    private const val LABEL_PADDING_Y = 6
    private const val MAX_BARCODE_CHARS = 10
    private const val CONTENT_WIDTH = 292
    private const val FULL_CONTENT_WIDTH = 390
    private const val PRICE_WIDTH = 245
    private const val BARCODE_LEFT = 5
    private const val BARCODE_MAX_WIDTH = 250
    private const val META_LEFT = 264
    private const val MIN_FITTED_TEXT_SIZE = 7f
    private const val FONT_FIT_ITERATIONS = 10
    private val CODE128_SYMBOLS = listOf(
      "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312",
      "132212", "221213", "221312", "231212", "112232", "122132", "122231", "113222",
      "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131",
      "311222", "321122", "321221", "312212", "322112", "322211", "212123", "212321",
      "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
      "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121",
      "313121", "211331", "231131", "213113", "213311", "213131", "311123", "311321",
      "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224",
      "111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114",
      "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
      "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112",
      "421211", "212141", "214121", "412121", "111143", "111341", "131141", "114113",
      "114311", "411113", "411311", "113141", "114131", "311141", "411131", "211412",
      "211214", "211232", "2331112",
    )
  }
}