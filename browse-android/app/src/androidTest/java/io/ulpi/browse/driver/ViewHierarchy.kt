package io.ulpi.browse.driver

import android.accessibilityservice.AccessibilityServiceInfo
import android.app.UiAutomation
import android.graphics.Rect
import android.os.Build
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import org.json.JSONArray
import org.json.JSONObject

/**
 * Traverses the Android accessibility tree and serialises it as JSON
 * matching the host-side RawAndroidNode contract.
 *
 * The tree is scoped to windows owned by [targetPackage] so the host
 * only sees the app under test, not the system UI / launcher.
 */
object ViewHierarchy {

    /**
     * Dump the full accessibility tree for [targetPackage] as a JSON object.
     *
     * Returns a single root RawAndroidNode with all children nested.
     * If the target package has no visible windows, returns a synthetic
     * empty root so the host always gets valid JSON.
     */
    fun dump(uiAutomation: UiAutomation, targetPackage: String): JSONObject {
        // Ensure we can see all windows (not just the active one)
        ensureAllWindowsFlag(uiAutomation)

        val roots = findTargetRoots(uiAutomation, targetPackage)
        if (roots.isEmpty()) {
            return emptyRoot()
        }

        // If exactly one window, use its root directly
        if (roots.size == 1) {
            return serializeNode(roots[0], intArrayOf())
        }

        // Multiple windows (e.g. dialog over activity) — wrap in synthetic root
        val syntheticRoot = JSONObject()
        syntheticRoot.put("path", JSONArray())
        syntheticRoot.put("className", "android.view.ViewGroup")
        syntheticRoot.put("text", JSONObject.NULL)
        syntheticRoot.put("hint", JSONObject.NULL)
        syntheticRoot.put("resourceId", JSONObject.NULL)
        syntheticRoot.put("bounds", boundsJson(Rect(0, 0, 0, 0)))
        syntheticRoot.put("clickable", false)
        syntheticRoot.put("longClickable", false)
        syntheticRoot.put("enabled", true)
        syntheticRoot.put("focused", false)
        syntheticRoot.put("selected", false)
        syntheticRoot.put("checked", false)
        syntheticRoot.put("checkable", false)
        syntheticRoot.put("editable", false)
        syntheticRoot.put("scrollable", false)
        syntheticRoot.put("visibleToUser", true)

        val children = JSONArray()
        roots.forEachIndexed { i, root ->
            children.put(serializeNode(root, intArrayOf(i)))
        }
        syntheticRoot.put("children", children)
        return syntheticRoot
    }

    /**
     * Count the total number of accessibility nodes for the target package.
     * Fast path — no JSON serialisation.
     */
    fun nodeCount(uiAutomation: UiAutomation, targetPackage: String): Int {
        ensureAllWindowsFlag(uiAutomation)
        val roots = findTargetRoots(uiAutomation, targetPackage)
        return roots.sumOf { countNodes(it) }
    }

    // ─── Internals ────────────────────────────────────────────────

    private fun ensureAllWindowsFlag(uiAutomation: UiAutomation) {
        try {
            val info = uiAutomation.serviceInfo
                ?: AccessibilityServiceInfo()
            info.flags = info.flags or
                AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS or
                AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
            uiAutomation.serviceInfo = info
        } catch (_: Exception) {
            // Best-effort — some API levels may not support this
        }
    }

    /**
     * Find accessibility tree roots belonging to [targetPackage].
     * Walks all windows and picks those whose root node's package matches.
     */
    private fun findTargetRoots(
        uiAutomation: UiAutomation,
        targetPackage: String,
    ): List<AccessibilityNodeInfo> {
        val roots = mutableListOf<AccessibilityNodeInfo>()

        // Try reflection on UiDevice.getWindowRoots() first (same technique as Maestro).
        // This returns ALL window roots including WebView renderer windows that
        // aren't visible via uiAutomation.windows.
        try {
            val uiDevice = androidx.test.uiautomator.UiDevice.getInstance(
                androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
            )
            val method = uiDevice.javaClass.getDeclaredMethod("getWindowRoots")
            method.isAccessible = true
            @Suppress("UNCHECKED_CAST")
            val allRoots = method.invoke(uiDevice) as? Array<AccessibilityNodeInfo>
            if (allRoots != null) {
                for (root in allRoots) {
                    val pkg = root.packageName?.toString() ?: continue
                    if (pkg == targetPackage) {
                        roots.add(root)
                    }
                }
            }
        } catch (_: Exception) {
            // Reflection failed — fall through to standard approach
        }

        // Standard approach: uiAutomation.windows
        if (roots.isEmpty()) {
            try {
                val windows: List<AccessibilityWindowInfo> = uiAutomation.windows ?: emptyList()
                for (window in windows) {
                    val root = window.root ?: continue
                    val pkg = root.packageName?.toString() ?: continue
                    if (pkg == targetPackage) {
                        roots.add(root)
                    }
                }
            } catch (_: Exception) {}
        }

        // Fallback: active window regardless of package
        if (roots.isEmpty()) {
            val activeRoot = uiAutomation.rootInActiveWindow
            if (activeRoot != null) {
                roots.add(activeRoot)
            }
        }

        return roots
    }

    /**
     * Recursively serialise an AccessibilityNodeInfo to a RawAndroidNode JSON object.
     * [parentPath] is the child-index path from root to the parent.
     */
    private fun serializeNode(
        node: AccessibilityNodeInfo,
        path: IntArray,
        insideWebView: Boolean = false,
    ): JSONObject {
        val obj = JSONObject()

        // Path
        obj.put("path", intArrayToJson(path))

        // Class name
        obj.put("className", node.className?.toString() ?: "android.view.View")

        // Text — prefer text, fall back to contentDescription
        val text = node.text?.toString()
        val contentDesc = node.contentDescription?.toString()
        obj.put("text", text ?: contentDesc ?: JSONObject.NULL)

        // Hint text (API 26+)
        val hint = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            node.hintText?.toString()
        } else {
            null
        }
        obj.put("hint", hint ?: JSONObject.NULL)

        // Resource ID
        obj.put("resourceId", node.viewIdResourceName ?: JSONObject.NULL)

        // Bounds
        val bounds = Rect()
        node.getBoundsInScreen(bounds)
        obj.put("bounds", boundsJson(bounds))

        // State flags
        obj.put("clickable", node.isClickable)
        obj.put("longClickable", node.isLongClickable)
        obj.put("enabled", node.isEnabled)
        obj.put("focused", node.isFocused)
        obj.put("selected", node.isSelected)
        obj.put("checked", node.isChecked)
        obj.put("checkable", node.isCheckable)
        obj.put("editable", node.isEditable)
        obj.put("scrollable", node.isScrollable)
        obj.put("visibleToUser", node.isVisibleToUser)

        // Detect if this node is a WebView — content inside may be marked invisible
        val className = node.className?.toString() ?: ""
        val isWebView = insideWebView || className.contains("WebView", ignoreCase = true)

        // Children
        val children = JSONArray()
        val childCount = node.childCount
        for (i in 0 until childCount) {
            val child = node.getChild(i) ?: continue
            // Allow invisible nodes inside WebViews (Android accessibility bug)
            if (!child.isVisibleToUser && !isWebView) {
                child.recycle()
                continue
            }
            children.put(serializeNode(child, path + i, isWebView))
        }
        obj.put("children", children)

        return obj
    }

    private fun countNodes(node: AccessibilityNodeInfo): Int {
        var count = 1
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            if (child.isVisibleToUser) {
                count += countNodes(child)
            }
        }
        return count
    }

    private fun boundsJson(rect: Rect): JSONObject {
        val obj = JSONObject()
        obj.put("left", rect.left)
        obj.put("top", rect.top)
        obj.put("right", rect.right)
        obj.put("bottom", rect.bottom)
        return obj
    }

    private fun intArrayToJson(arr: IntArray): JSONArray {
        val json = JSONArray()
        for (v in arr) json.put(v)
        return json
    }

    private fun emptyRoot(): JSONObject {
        val obj = JSONObject()
        obj.put("path", JSONArray())
        obj.put("className", "android.view.ViewGroup")
        obj.put("text", JSONObject.NULL)
        obj.put("hint", JSONObject.NULL)
        obj.put("resourceId", JSONObject.NULL)
        obj.put("bounds", boundsJson(Rect(0, 0, 0, 0)))
        obj.put("clickable", false)
        obj.put("longClickable", false)
        obj.put("enabled", true)
        obj.put("focused", false)
        obj.put("selected", false)
        obj.put("checked", false)
        obj.put("checkable", false)
        obj.put("editable", false)
        obj.put("scrollable", false)
        obj.put("visibleToUser", true)
        obj.put("children", JSONArray())
        return obj
    }
}
