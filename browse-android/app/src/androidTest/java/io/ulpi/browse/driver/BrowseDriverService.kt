package io.ulpi.browse.driver

import android.app.ActivityManager
import android.app.Instrumentation
import android.app.UiAutomation
import android.content.Context
import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.KeyEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.Configurator
import androidx.test.uiautomator.UiDevice
import fi.iki.elonen.NanoHTTPD
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * On-device driver service for browse Android automation.
 *
 * Runs as an Android instrumentation test that starts a NanoHTTPD HTTP server.
 * The host communicates via `adb forward tcp:7779 tcp:7779`.
 *
 * Endpoints match the host-side AndroidDriverProtocol contract:
 *   GET  /health     → { status: "ok" }
 *   POST /tree       → RawAndroidNode (accessibility tree scoped to target package)
 *   POST /action     → { success, error? }
 *   POST /setValue    → { success, error? }
 *   POST /type       → { success, error? }
 *   POST /press      → { success, error? }
 *   POST /screenshot  → { success, error? }
 *   GET  /state      → AndroidState
 */
@RunWith(AndroidJUnit4::class)
class BrowseDriverService {

    companion object {
        private const val TAG = "BrowseDriver"
        private const val DEFAULT_PORT = 7779
    }

    @Test
    fun startDriver() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val arguments = InstrumentationRegistry.getArguments()
        val targetPackage = arguments.getString("targetPackage")
            ?: throw IllegalArgumentException(
                "targetPackage argument is required. " +
                "Pass it via: am instrument -e targetPackage com.example.app ..."
            )

        val port = arguments.getString("port")?.toIntOrNull() ?: DEFAULT_PORT

        // Zero out UiAutomator timeouts — we manage our own waits
        Configurator.getInstance().apply {
            waitForIdleTimeout = 0L
            waitForSelectorTimeout = 0L
            actionAcknowledgmentTimeout = 0L
        }

        val uiDevice = UiDevice.getInstance(instrumentation)
        val uiAutomation = instrumentation.uiAutomation
        val context = instrumentation.targetContext

        Log.i(TAG, "Starting browse driver on port $port for package $targetPackage")

        val server = DriverServer(port, targetPackage, uiDevice, uiAutomation, context)
        server.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false)

        Log.i(TAG, "Driver server started on port $port")

        // Block forever — the server runs until the instrumentation process is killed
        try {
            Thread.sleep(Long.MAX_VALUE)
        } catch (_: InterruptedException) {
            Log.i(TAG, "Driver interrupted, shutting down")
        } finally {
            server.stop()
        }
    }
}

/**
 * NanoHTTPD server implementing the browse driver protocol.
 */
private class DriverServer(
    port: Int,
    private val targetPackage: String,
    private val uiDevice: UiDevice,
    private val uiAutomation: UiAutomation,
    private val context: Context,
) : NanoHTTPD(port) {

    companion object {
        private const val TAG = "BrowseDriver"
    }

    override fun serve(session: IHTTPSession): Response {
        return try {
            route(session)
        } catch (e: Exception) {
            Log.e(TAG, "Request failed: ${session.uri}", e)
            errorResponse(500, e.message ?: "Internal error")
        }
    }

    private fun route(session: IHTTPSession): Response {
        val uri = session.uri
        val method = session.method

        return when {
            uri == "/health" && method == Method.GET -> handleHealth()
            uri == "/tree" && method == Method.POST -> handleTree()
            uri == "/action" && method == Method.POST -> handleAction(session)
            uri == "/setValue" && method == Method.POST -> handleSetValue(session)
            uri == "/type" && method == Method.POST -> handleType(session)
            uri == "/press" && method == Method.POST -> handlePress(session)
            uri == "/screenshot" && method == Method.POST -> handleScreenshot(session)
            uri == "/state" && method == Method.GET -> handleState()
            else -> errorResponse(404, "Unknown endpoint: $method $uri")
        }
    }

    // ─── Endpoint handlers ────────────────────────────────────────

    private fun handleHealth(): Response {
        val json = JSONObject()
        json.put("status", "ok")
        return jsonResponse(json)
    }

    private fun handleTree(): Response {
        // Wait briefly for any pending UI updates to settle
        uiDevice.waitForIdle(500)

        val tree = ViewHierarchy.dump(uiAutomation, targetPackage)
        return jsonResponse(tree)
    }

    private fun handleAction(session: IHTTPSession): Response {
        val body = readBody(session)
        val path = jsonArrayToIntArray(body.getJSONArray("path"))
        val action = body.getString("action")

        val node = findNodeByPath(path)
            ?: return successResponse(false, "Node not found at path ${path.toList()}")

        val actionId = resolveAction(action)
            ?: return successResponse(false, "Unknown action: $action")

        val ok = node.performAction(actionId)
        return if (ok) {
            successResponse(true)
        } else {
            successResponse(false, "Action '$action' returned false for node at path ${path.toList()}")
        }
    }

    private fun handleSetValue(session: IHTTPSession): Response {
        val body = readBody(session)
        val path = jsonArrayToIntArray(body.getJSONArray("path"))
        val value = body.getString("value")

        val node = findNodeByPath(path)
            ?: return successResponse(false, "Node not found at path ${path.toList()}")

        if (!node.isEditable) {
            return successResponse(false, "Node at path ${path.toList()} is not editable")
        }

        val args = Bundle()
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value)
        val ok = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        return if (ok) {
            successResponse(true)
        } else {
            successResponse(false, "ACTION_SET_TEXT returned false")
        }
    }

    private fun handleType(session: IHTTPSession): Response {
        val body = readBody(session)
        val text = body.getString("text")

        // Type each character via UiDevice key injection
        for (char in text) {
            val keyCode = charToKeyCode(char)
            if (keyCode != null) {
                val (code, meta) = keyCode
                uiDevice.pressKeyCode(code, meta)
            } else {
                // Fallback: use clipboard paste for unsupported characters
                val clipManager = context.getSystemService(Context.CLIPBOARD_SERVICE)
                    as android.content.ClipboardManager
                clipManager.setPrimaryClip(
                    android.content.ClipData.newPlainText("browse", char.toString())
                )
                // Ctrl+V to paste
                uiDevice.pressKeyCode(KeyEvent.KEYCODE_V, KeyEvent.META_CTRL_ON)
            }
            Thread.sleep(30)
        }

        return successResponse(true)
    }

    private fun handlePress(session: IHTTPSession): Response {
        val body = readBody(session)
        val key = body.getString("key")

        val keyCode = resolveKeyName(key)
            ?: return successResponse(false, "Unknown key: $key")

        uiDevice.pressKeyCode(keyCode)
        return successResponse(true)
    }

    private fun handleScreenshot(session: IHTTPSession): Response {
        val body = readBody(session)
        val outputPath = body.getString("outputPath")

        val bitmap = uiAutomation.takeScreenshot()
            ?: return successResponse(false, "takeScreenshot() returned null")

        return try {
            val file = File(outputPath)
            file.outputStream().use { out ->
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
            }
            successResponse(true)
        } catch (e: Exception) {
            successResponse(false, "Failed to write screenshot: ${e.message}")
        } finally {
            bitmap.recycle()
        }
    }

    private fun handleState(): Response {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager

        // Foreground package and activity
        var packageName = targetPackage
        var activityName = ""

        @Suppress("DEPRECATION")
        val tasks = am.getRunningTasks(1)
        if (tasks.isNotEmpty()) {
            val top = tasks[0].topActivity
            if (top != null) {
                packageName = top.packageName
                activityName = top.className
            }
        }

        // Window title from the focused node
        val windowTitle = try {
            val root = uiAutomation.rootInActiveWindow
            root?.contentDescription?.toString()
                ?: root?.text?.toString()
        } catch (_: Exception) {
            null
        }

        // Node count
        val nodeCount = try {
            ViewHierarchy.nodeCount(uiAutomation, targetPackage)
        } catch (_: Exception) {
            0
        }

        // Interactive: screen on and not locked
        val interactive = uiDevice.isScreenOn

        val json = JSONObject()
        json.put("packageName", packageName)
        json.put("activityName", activityName)
        json.put("windowTitle", windowTitle ?: JSONObject.NULL)
        json.put("nodeCount", nodeCount)
        json.put("interactive", interactive)

        return jsonResponse(json)
    }

    // ─── Node resolution ──────────────────────────────────────────

    /**
     * Find a node by its child-index path from the root.
     * Traverses the accessibility tree following [path] indices.
     */
    private fun findNodeByPath(path: IntArray): AccessibilityNodeInfo? {
        uiDevice.waitForIdle(300)

        // Get fresh roots
        val roots = findTargetRoots()
        if (roots.isEmpty()) return null

        // Path is empty → return the root (or synthetic root for multiple windows)
        if (path.isEmpty()) {
            return if (roots.size == 1) roots[0] else null
        }

        // First index selects the window root (if multiple), rest navigate children
        var node: AccessibilityNodeInfo
        var startIdx: Int

        if (roots.size > 1) {
            // Multi-window: first path element is the window index
            val windowIdx = path[0]
            if (windowIdx < 0 || windowIdx >= roots.size) return null
            node = roots[windowIdx]
            startIdx = 1
        } else {
            node = roots[0]
            startIdx = 0
        }

        for (i in startIdx until path.size) {
            val childIdx = path[i]
            // We need to account for invisible children being skipped in the tree
            var visibleIdx = 0
            var found = false
            for (ci in 0 until node.childCount) {
                val child = node.getChild(ci) ?: continue
                if (!child.isVisibleToUser) {
                    continue
                }
                if (visibleIdx == childIdx) {
                    node = child
                    found = true
                    break
                }
                visibleIdx++
            }
            if (!found) return null
        }

        return node
    }

    private fun findTargetRoots(): List<AccessibilityNodeInfo> {
        val roots = mutableListOf<AccessibilityNodeInfo>()
        try {
            val windows = uiAutomation.windows ?: emptyList()
            for (window in windows) {
                val root = window.root ?: continue
                if (root.packageName?.toString() == targetPackage) {
                    roots.add(root)
                }
            }
        } catch (_: Exception) {}

        if (roots.isEmpty()) {
            val activeRoot = uiAutomation.rootInActiveWindow
            if (activeRoot?.packageName?.toString() == targetPackage) {
                roots.add(activeRoot)
            }
        }
        return roots
    }

    // ─── Action resolution ────────────────────────────────────────

    private fun resolveAction(name: String): Int? {
        return when (name.lowercase()) {
            "click" -> AccessibilityNodeInfo.ACTION_CLICK
            "longclick", "long_click" -> AccessibilityNodeInfo.ACTION_LONG_CLICK
            "focus", "accessibilityfocus" -> AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS
            "clearfocus", "clearaccessibilityfocus" -> AccessibilityNodeInfo.ACTION_CLEAR_ACCESSIBILITY_FOCUS
            "select" -> AccessibilityNodeInfo.ACTION_SELECT
            "clearselection" -> AccessibilityNodeInfo.ACTION_CLEAR_SELECTION
            "scrollforward", "scroll_forward" -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
            "scrollbackward", "scroll_backward" -> AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
            "expand" -> AccessibilityNodeInfo.ACTION_EXPAND
            "collapse" -> AccessibilityNodeInfo.ACTION_COLLAPSE
            else -> null
        }
    }

    // ─── Key name resolution ──────────────────────────────────────

    private fun resolveKeyName(name: String): Int? {
        return when (name.uppercase()) {
            "ENTER", "RETURN" -> KeyEvent.KEYCODE_ENTER
            "BACK" -> KeyEvent.KEYCODE_BACK
            "HOME" -> KeyEvent.KEYCODE_HOME
            "DPAD_UP" -> KeyEvent.KEYCODE_DPAD_UP
            "DPAD_DOWN" -> KeyEvent.KEYCODE_DPAD_DOWN
            "DPAD_LEFT" -> KeyEvent.KEYCODE_DPAD_LEFT
            "DPAD_RIGHT" -> KeyEvent.KEYCODE_DPAD_RIGHT
            "TAB" -> KeyEvent.KEYCODE_TAB
            "SPACE" -> KeyEvent.KEYCODE_SPACE
            "DEL", "BACKSPACE" -> KeyEvent.KEYCODE_DEL
            "FORWARD_DEL", "DELETE" -> KeyEvent.KEYCODE_FORWARD_DEL
            "ESCAPE", "ESC" -> KeyEvent.KEYCODE_ESCAPE
            "MENU" -> KeyEvent.KEYCODE_MENU
            "SEARCH" -> KeyEvent.KEYCODE_SEARCH
            "VOLUME_UP" -> KeyEvent.KEYCODE_VOLUME_UP
            "VOLUME_DOWN" -> KeyEvent.KEYCODE_VOLUME_DOWN
            "CAMERA" -> KeyEvent.KEYCODE_CAMERA
            "POWER" -> KeyEvent.KEYCODE_POWER
            else -> null
        }
    }

    // ─── Character → keycode mapping ─────────────────────────────

    /**
     * Map a character to (keyCode, metaState).
     * Returns null for characters that need clipboard-paste fallback.
     */
    private fun charToKeyCode(char: Char): Pair<Int, Int>? {
        return when (char) {
            in '0'..'9' -> Pair(KeyEvent.KEYCODE_0 + (char - '0'), 0)
            in 'a'..'z' -> Pair(KeyEvent.KEYCODE_A + (char - 'a'), 0)
            in 'A'..'Z' -> Pair(KeyEvent.KEYCODE_A + (char - 'A'), KeyEvent.META_SHIFT_ON)
            ' ' -> Pair(KeyEvent.KEYCODE_SPACE, 0)
            '\n' -> Pair(KeyEvent.KEYCODE_ENTER, 0)
            '\t' -> Pair(KeyEvent.KEYCODE_TAB, 0)
            '.' -> Pair(KeyEvent.KEYCODE_PERIOD, 0)
            ',' -> Pair(KeyEvent.KEYCODE_COMMA, 0)
            ';' -> Pair(KeyEvent.KEYCODE_SEMICOLON, 0)
            ':' -> Pair(KeyEvent.KEYCODE_SEMICOLON, KeyEvent.META_SHIFT_ON)
            '\'' -> Pair(KeyEvent.KEYCODE_APOSTROPHE, 0)
            '"' -> Pair(KeyEvent.KEYCODE_APOSTROPHE, KeyEvent.META_SHIFT_ON)
            '-' -> Pair(KeyEvent.KEYCODE_MINUS, 0)
            '_' -> Pair(KeyEvent.KEYCODE_MINUS, KeyEvent.META_SHIFT_ON)
            '=' -> Pair(KeyEvent.KEYCODE_EQUALS, 0)
            '+' -> Pair(KeyEvent.KEYCODE_EQUALS, KeyEvent.META_SHIFT_ON)
            '/' -> Pair(KeyEvent.KEYCODE_SLASH, 0)
            '?' -> Pair(KeyEvent.KEYCODE_SLASH, KeyEvent.META_SHIFT_ON)
            '\\' -> Pair(KeyEvent.KEYCODE_BACKSLASH, 0)
            '|' -> Pair(KeyEvent.KEYCODE_BACKSLASH, KeyEvent.META_SHIFT_ON)
            '[' -> Pair(KeyEvent.KEYCODE_LEFT_BRACKET, 0)
            ']' -> Pair(KeyEvent.KEYCODE_RIGHT_BRACKET, 0)
            '{' -> Pair(KeyEvent.KEYCODE_LEFT_BRACKET, KeyEvent.META_SHIFT_ON)
            '}' -> Pair(KeyEvent.KEYCODE_RIGHT_BRACKET, KeyEvent.META_SHIFT_ON)
            '`' -> Pair(KeyEvent.KEYCODE_GRAVE, 0)
            '~' -> Pair(KeyEvent.KEYCODE_GRAVE, KeyEvent.META_SHIFT_ON)
            '!' -> Pair(KeyEvent.KEYCODE_1, KeyEvent.META_SHIFT_ON)
            '@' -> Pair(KeyEvent.KEYCODE_2, KeyEvent.META_SHIFT_ON)
            '#' -> Pair(KeyEvent.KEYCODE_3, KeyEvent.META_SHIFT_ON)
            '$' -> Pair(KeyEvent.KEYCODE_4, KeyEvent.META_SHIFT_ON)
            '%' -> Pair(KeyEvent.KEYCODE_5, KeyEvent.META_SHIFT_ON)
            '^' -> Pair(KeyEvent.KEYCODE_6, KeyEvent.META_SHIFT_ON)
            '&' -> Pair(KeyEvent.KEYCODE_7, KeyEvent.META_SHIFT_ON)
            '*' -> Pair(KeyEvent.KEYCODE_8, KeyEvent.META_SHIFT_ON)
            '(' -> Pair(KeyEvent.KEYCODE_9, KeyEvent.META_SHIFT_ON)
            ')' -> Pair(KeyEvent.KEYCODE_0, KeyEvent.META_SHIFT_ON)
            else -> null // Unsupported character — will use clipboard paste
        }
    }

    // ─── JSON / HTTP helpers ──────────────────────────────────────

    private fun readBody(session: IHTTPSession): JSONObject {
        val contentLength = session.headers["content-length"]?.toIntOrNull() ?: 0
        if (contentLength == 0) return JSONObject()

        val buffer = ByteArray(contentLength)
        session.inputStream.read(buffer, 0, contentLength)
        return JSONObject(String(buffer))
    }

    private fun jsonResponse(json: JSONObject): Response {
        return newFixedLengthResponse(
            Response.Status.OK,
            "application/json",
            json.toString()
        )
    }

    private fun successResponse(success: Boolean, error: String? = null): Response {
        val json = JSONObject()
        json.put("success", success)
        if (error != null) json.put("error", error)
        return jsonResponse(json)
    }

    private fun errorResponse(code: Int, message: String): Response {
        val json = JSONObject()
        json.put("success", false)
        json.put("error", message)
        val status = when (code) {
            400 -> Response.Status.BAD_REQUEST
            404 -> Response.Status.NOT_FOUND
            else -> Response.Status.INTERNAL_ERROR
        }
        return newFixedLengthResponse(status, "application/json", json.toString())
    }

    private fun jsonArrayToIntArray(arr: JSONArray): IntArray {
        return IntArray(arr.length()) { arr.getInt(it) }
    }
}
