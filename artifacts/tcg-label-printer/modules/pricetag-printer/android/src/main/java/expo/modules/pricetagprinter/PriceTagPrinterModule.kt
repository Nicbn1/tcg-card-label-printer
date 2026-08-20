package expo.modules.pricetagprinter

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothSocket
import android.os.Build
import android.util.Base64
import expo.modules.interfaces.permissions.PermissionsResponseListener
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.IOException
import java.util.UUID
import kotlin.coroutines.resume

/**
 * Bluetooth SPP transport for a paired Core Tech N12 thermal printer.
 *
 * The N12 is paired through Android Settings first. This module intentionally
 * lists paired devices only: it does not initiate nearby-device discovery.
 */
class PriceTagPrinterModule : Module() {
  private var socket: BluetoothSocket? = null
  private var connectedAddress: String? = null

  override fun definition() = ModuleDefinition {
    Name("PriceTagPrinter")

    AsyncFunction("getPermissionStatusAsync") Coroutine {
      getPermissionStatus()
    }

    AsyncFunction("requestPermissionsAsync") Coroutine {
      requestBluetoothPermissions()
    }

    AsyncFunction("getPairedDevicesAsync") Coroutine {
      withContext(Dispatchers.IO) {
        requireBluetoothPermission()
        pairedDevices()
      }
    }

    AsyncFunction("connectAsync") Coroutine { address: String ->
      withContext(Dispatchers.IO) {
        connect(address)
      }
    }

    AsyncFunction("writeBase64Async") Coroutine { base64Data: String ->
      withContext(Dispatchers.IO) {
        write(base64Data)
      }
    }

    AsyncFunction("disconnectAsync") Coroutine {
      withContext(Dispatchers.IO) {
        closeConnection()
      }
    }

    AsyncFunction("getConnectionStateAsync") {
      mapOf(
        "connected" to (socket?.isConnected == true),
        "address" to connectedAddress
      )
    }

    OnDestroy {
      closeConnection()
    }
  }

  private fun requiredRuntimePermissions(): Array<String> =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
    } else {
      emptyArray()
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
        "BLUETOOTH_PERMISSION_REQUIRED: Allow Nearby devices access to connect to the N12."
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
  private fun pairedDevices(): List<Map<String, String>> {
    val devices = bluetoothAdapter().bondedDevices
      .map { deviceToMap(it) }
      .sortedBy { device -> device["name"]?.lowercase() ?: "" }
    return devices
  }

  @SuppressLint("MissingPermission")
  private fun deviceToMap(device: BluetoothDevice): Map<String, String> =
    mapOf(
      "name" to (device.name ?: "Unnamed Bluetooth device"),
      "address" to device.address
    )

  @SuppressLint("MissingPermission")
  private fun connect(address: String): Map<String, String> {
    val normalizedAddress = address.trim().uppercase()
    if (normalizedAddress.isBlank()) {
      throw IllegalArgumentException("PRINTER_ADDRESS_REQUIRED: Select a paired N12 before printing.")
    }
    if (socket?.isConnected == true && connectedAddress == normalizedAddress) {
      return mapOf("address" to normalizedAddress)
    }

    val adapter = bluetoothAdapter()
    val device = adapter.bondedDevices.firstOrNull { it.address.equals(normalizedAddress, ignoreCase = true) }
      ?: throw IllegalArgumentException(
        "PRINTER_NOT_PAIRED: Pair the N12 in Android Bluetooth settings, then select it in PriceTag."
      )

    closeConnection()
    adapter.cancelDiscovery()

    try {
      val newSocket = device.createRfcommSocketToServiceRecord(SPP_UUID)
      newSocket.connect()
      socket = newSocket
      connectedAddress = device.address
      return deviceToMap(device)
    } catch (error: IOException) {
      closeConnection()
      throw IOException(
        "PRINTER_CONNECTION_FAILED: Could not connect to ${device.name ?: device.address}. Check that the N12 is powered on and paired.",
        error
      )
    }
  }

  private fun write(base64Data: String) {
    val activeSocket = socket
    if (activeSocket?.isConnected != true) {
      throw IllegalStateException("PRINTER_NOT_CONNECTED: Select and connect your N12 before printing.")
    }

    try {
      val data = Base64.decode(base64Data, Base64.DEFAULT)
      activeSocket.outputStream.use { output ->
        output.write(data)
        output.flush()
      }
      // outputStream.use closes the socket's stream; the socket is no longer reusable.
      closeConnection()
    } catch (error: IllegalArgumentException) {
      throw IllegalArgumentException("PRINTER_DATA_INVALID: The label payload could not be encoded.", error)
    } catch (error: IOException) {
      closeConnection()
      throw IOException("PRINTER_WRITE_FAILED: The N12 disconnected before the label was sent.", error)
    }
  }

  private fun closeConnection() {
    try {
      socket?.close()
    } catch (_: IOException) {
      // The connection is already unusable; clear it below.
    } finally {
      socket = null
      connectedAddress = null
    }
  }

  companion object {
    private val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
  }
}