package expo.modules.pricetagprinter

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.fail
import org.junit.Test

class D11ProtocolTest {
  @Test
  fun `12 mm D11 preflight sends only the big endian row count`() {
    val frames = D11Protocol.preflightFrames(height = 400)

    assertEquals(
      listOf(
        "55 55 21 01 02 22 AA AA",
        "55 55 23 01 01 23 AA AA",
        "55 55 01 01 01 01 AA AA",
        "55 55 20 01 01 20 AA AA",
        "55 55 03 01 01 03 AA AA",
        "55 55 13 02 01 90 80 AA AA",
        "55 55 15 02 00 01 16 AA AA",
      ),
      frames.map(::hex),
    )
  }

  @Test
  fun `print starts before page setup commands`() {
    val commands = D11Protocol.preflightFrames(400).map(D11Protocol::command)

    assertEquals(listOf(0x21, 0x23, 0x01, 0x20, 0x03, 0x13, 0x15), commands)
    assertEquals(2, commands.indexOf(0x01))
    assertEquals(true, commands.indexOf(0x01) < commands.indexOf(0x20))
    assertEquals(true, commands.indexOf(0x01) < commands.indexOf(0x03))
    assertEquals(true, commands.indexOf(0x01) < commands.indexOf(0x13))
  }

  @Test
  fun `setup commands map to their D11 acknowledgement commands`() {
    assertEquals(0x31, D11Protocol.expectedResponseCommand(0x21))
    assertEquals(0x33, D11Protocol.expectedResponseCommand(0x23))
    assertEquals(0x02, D11Protocol.expectedResponseCommand(0x01))
    assertEquals(0x30, D11Protocol.expectedResponseCommand(0x20))
    assertEquals(0x04, D11Protocol.expectedResponseCommand(0x03))
    assertEquals(0x14, D11Protocol.expectedResponseCommand(0x13))
    assertEquals(0x16, D11Protocol.expectedResponseCommand(0x15))
    assertEquals(0xE4, D11Protocol.expectedResponseCommand(0xE3))
    assertEquals(0xB3, D11Protocol.expectedResponseCommand(0xA3))
    assertEquals(0xF4, D11Protocol.expectedResponseCommand(0xF3))
  }

  @Test
  fun `counter clockwise transport mapping preserves all label corners`() {
    assertEquals(Pair(0, 399), D11Protocol.counterClockwiseTransportCoordinates(0, 0, 400))
    assertEquals(Pair(95, 399), D11Protocol.counterClockwiseTransportCoordinates(0, 95, 400))
    assertEquals(Pair(0, 0), D11Protocol.counterClockwiseTransportCoordinates(399, 0, 400))
    assertEquals(Pair(95, 0), D11Protocol.counterClockwiseTransportCoordinates(399, 95, 400))
  }

  @Test
  fun `device discovery only accepts D11 names`() {
    assertEquals(true, D11Protocol.isD11DeviceName("NIIMBOT D11"))
    assertEquals(true, D11Protocol.isD11DeviceName("D11-ABC123"))
    assertEquals(false, D11Protocol.isD11DeviceName("NIIMBOT N12"))
    assertEquals(false, D11Protocol.isD11DeviceName(null))
  }

  @Test
  fun `BLE discovery address maps to the D11 classic serial address`() {
    assertEquals(
      "03:26:03:C3:F9:11",
      D11Protocol.classicAddressForBle("26:03:03:c3:f9:11"),
    )
    assertEquals(null, D11Protocol.classicAddressForBle("not-an-address"))
  }

  @Test
  fun `no response delivery stays transport queued until status is received`() {
    val delivery = D11Protocol.deliveryMetadata(
      packetCount = 9,
      packetBytes = 52,
      statusReceived = false,
      completedPageCount = null,
    )

    assertEquals("rfcomm-stream", delivery["writeMode"])
    assertFalse(delivery["statusReceived"] as Boolean)
    assertEquals(null, delivery["completedPageCount"])
  }

  @Test
  fun `printer rejection remains latched until the job is reset`() {
    val rejection = D11PrintRejectionLatch()
    rejection.reset()
    val expected = rejection.reject()

    try {
      rejection.throwIfRejected()
      fail("A rejected D11 job must fail after later queued writes.")
    } catch (actual: java.io.IOException) {
      assertEquals(expected, actual)
    }

    rejection.reset()
    rejection.throwIfRejected()
  }

  private fun hex(bytes: ByteArray): String =
    bytes.joinToString(" ") { "%02X".format(it.toInt() and 0xFF) }
}