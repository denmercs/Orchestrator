package dev.denmercs.jarvis;

import android.accessibilityservice.AccessibilityService;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

/** Taps Paseo's "Enable Voice mode" button once, right after Jarvis opens Paseo. */
public class JarvisService extends AccessibilityService {
    static final MicTap TAP = new MicTap();
    private static volatile boolean running = false;

    static boolean isRunning() {
        return running;
    }

    @Override
    protected void onServiceConnected() {
        running = true;
    }

    @Override
    public boolean onUnbind(android.content.Intent intent) {
        running = false;
        return super.onUnbind(intent);
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (!TAP.isArmed(SystemClock.elapsedRealtime())) return;
        if (event.getPackageName() == null || !MicTap.PASEO.contentEquals(event.getPackageName())) return;
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return;
        // The button renders a mic icon with no text, so search by its description.
        for (AccessibilityNodeInfo node : root.findAccessibilityNodeInfosByText("Voice mode")) {
            if (MicTap.isVoiceButton(node.getContentDescription()) && click(node)) {
                TAP.disarm();
                return;
            }
        }
    }

    // React Native may put the description on a child of the pressable, so walk up to it.
    private static boolean click(AccessibilityNodeInfo node) {
        for (AccessibilityNodeInfo current = node; current != null; current = current.getParent()) {
            if (current.isClickable() && current.isEnabled()) {
                return current.performAction(AccessibilityNodeInfo.ACTION_CLICK);
            }
        }
        return false;
    }

    @Override
    public void onInterrupt() {}
}
