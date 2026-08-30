package expo.modules.pricetagprinter

import java.io.IOException

/**
 * Pure NIIMBOT V3 protocol helpers.
 *
 * Keeping the deterministic command encoding separate from Android BLE state
 * makes the D11 preflight contract testable without a phone or printer.
 */
internal object D11Protocol {
  const val STREAM_WRITE_MODE = "rfcomm-stream"

  private const val FRAME_HEAD: Byte = 0x55
  private const val FRAME_TAIL: Byte = 0xAA.toByte()
  private const val CMD_PAGE_START = 0x03
  private const val CMD_PRINT_QUANTITY = 0x15
  private const val CMD_SET_PAGE_SIZE = 0x13
  private const val CMD_PRINT_CLEAR = 0x20
  private const val CMD_SET_DENSITY = 0x21
  private const val CMD_SET_LABEL_TYPE = 0x23
  private const val CMD_PRINT_START = 0x01
  private const val D11_LABEL_TYPE = 1
  private const val D11_DENSITY = 2

  /**
   * Commands sent before bitmap rows. The print task must start before page
   * clear/start/size setup, and all 16-bit values are big-endian.
   */
  fun preflightFrames(width: Int, height: Int, quantity: Int = 1): List<ByteArray> =
    listOf(
      buildFrame(CMD_SET_DENSITY, byteArrayOf(D11_DENSITY.toByte())),
      buildFrame(CMD_SET_LABEL_TYPE, byteArrayOf(D11_LABEL_TYPE.toByte())),
      buildFrame(CMD_PRINT_START, byteArrayOf(0x01)),
      buildFrame(CMD_PRINT_CLEAR, byteArrayOf(0x01)),
      buildFrame(CMD_PAGE_START, byteArrayOf(0x01)),
      buildFrame(CMD_SET_PAGE_SIZE, u16(height) + u16(width)),
      buildFrame(CMD_PRINT_QUANTITY, u16(quantity)),
    )

  fun u16(value: Int): ByteArray =
    byteArrayOf(((value shr 8) and 0xFF).toByte(), (value and 0xFF).toByte())

  /**
   * Maps a landscape label pixel into the D11's print-head coordinate system
   * without relying on Android bitmap rotation or filtering.
   */
  fun counterClockwiseTransportCoordinates(
    logicalX: Int,
    logicalY: Int,
    logicalWidth: Int,
  ): Pair<Int, Int> = Pair(logicalY, logicalWidth - 1 - logicalX)

  fun isD11DeviceName(name: String?): Boolean =
    name?.contains("D11", ignoreCase = true) == true

  /**
   * D11 units advertise BLE and classic serial addresses with the first two
   * octets exchanged (for example 26:03:... over BLE and 03:26:... for SPP).
   */
  fun classicAddressForBle(address: String): String? {
    val octets = address.trim().uppercase().split(":")
    if (octets.size != 6 || octets.any { it.length != 2 || it.toIntOrNull(16) == null }) return null
    return (listOf(octets[1], octets[0]) + octets.drop(2)).joinToString(":")
  }

  fun buildFrame(command: Int, data: ByteArray): ByteArray {
    require(data.size <= 0xFF) { "NIIMBOT D11 packet data exceeds 255 bytes." }
    var checksum = command xor data.size
    data.forEach { byte -> checksum = checksum xor (byte.toInt() and 0xFF) }
    return byteArrayOf(
      FRAME_HEAD,
      FRAME_HEAD,
      command.toByte(),
      data.size.toByte()
    ) + data + byteArrayOf(
      checksum.toByte(),
      FRAME_TAIL,
      FRAME_TAIL
    )
  }

  fun command(frame: ByteArray): Int {
    require(frame.size >= 3) { "NIIMBOT D11 frame is missing its command byte." }
    return frame[2].toInt() and 0xFF
  }

  fun expectedResponseCommand(command: Int): Int =
    when (command) {
      0x21, 0x23, 0x20, 0xA3 -> command + 0x10
      else -> command + 0x01
    }

  fun deliveryMetadata(
    packetCount: Int,
    packetBytes: Int,
    statusReceived: Boolean,
    completedPageCount: Int?
  ): Map<String, Any?> = mapOf(
    "packetCount" to packetCount,
    "writeMode" to STREAM_WRITE_MODE,
    "packetBytes" to packetBytes,
    "statusReceived" to statusReceived,
    "completedPageCount" to completedPageCount
  )
}

/**
 * Tracks an asynchronous printer rejection for the lifetime of one print job.
 *
 * Callers provide synchronization because Bluetooth notifications and queued
 * writes arrive on different threads.
 */
internal class D11PrintRejectionLatch {
  private var pendingError: IOException? = null

  fun reset() {
    pendingError = null
  }

  fun reject(): IOException =
    IOException(
      "D11_PRINT_REJECTED: The NIIMBOT D11 rejected the label setup. Check the installed tape and try again."
    ).also { pendingError = it }

  fun throwIfRejected() {
    pendingError?.let { throw it }
  }
}