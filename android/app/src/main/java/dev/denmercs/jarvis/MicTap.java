package dev.denmercs.jarvis;

/**
 * Whether a tap on Paseo's voice mode button is wanted. Opening Jarvis arms it for a few seconds,
 * long enough for Paseo to come up; the service taps once and disarms. Outside that window the
 * service ignores Paseo entirely.
 */
final class MicTap {
    static final String PASEO = "sh.paseo";
    static final long WINDOW_MS = 10_000;

    // Paseo's accessibilityLabel for the button, English only (composer.voice.enableVoiceMode).
    private static final String VOICE_BUTTON = "Enable Voice mode";

    private long armedUntil = 0;

    void arm(long now) {
        armedUntil = now + WINDOW_MS;
    }

    boolean isArmed(long now) {
        return now < armedUntil;
    }

    void disarm() {
        armedUntil = 0;
    }

    static boolean isVoiceButton(CharSequence description) {
        return description != null && VOICE_BUTTON.equalsIgnoreCase(description.toString().trim());
    }
}
