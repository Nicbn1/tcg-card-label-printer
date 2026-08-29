package expo.modules.pricetagprinter

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.fail
import org.junit.Test

class D11ProtocolTest {
  @Test
  fun `12 mm preflight uses exact big endian dimensions`() {
    val frames = D11Protocol.preflightFrames(width = 96, height = 400)

    assertEquals(
      listOf(
        "55 55 21 01 02 22 AA AA",
        "55 55 23 01 01 23 AA AA",
        "55 55 01 01 01 01 AA AA",
        "55 55 20 01 01 20 AA AA",
        "55 55 03 01 01 03 AA AA",
        "55 55 13 04 01 90 00 60 E6 AA AA",
        "55 55 15 02 00 01 16 AA AA",
      ),
      frames.map(::hex),
    )
  }

  @Test
  fun `print starts before page setup commands`() {
    val commands = D11Protocol.preflightFrames(96, 400).map(D11Protocol::command)

    assertEquals(listOf(0x21, 0x23, 0x01, 0x20, 0x03, 0x13, 0x15), commands)
    assertEquals(2, commands.indexOf(0x01))
    assertEquals(true, commands.indexOf(0x01) < commands.indexOf(0x20))
    assertEquals(true, commands.indexOf(0x01) < commands.indexOf(0x03))
    assertEquals(true, commands.indexOf(0x01) < commands.indexOf(0x13))
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
  fun `no response delivery stays transport queued until status is received`() {
    val delivery = D11Protocol.deliveryMetadata(
      packetCount = 9,
      packetBytes = 52,
      statusReceived = false,
      completedPageCount = null,
    )

    assertEquals("no-response-queued", delivery["writeMode"])
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