package dev.denmercs.jarvis;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class MicTapTest {
    @Test
    public void armsForTheWindowThenExpires() {
        MicTap tap = new MicTap();
        assertFalse(tap.isArmed(0));
        tap.arm(1_000);
        assertTrue(tap.isArmed(1_000 + MicTap.WINDOW_MS - 1));
        assertFalse(tap.isArmed(1_000 + MicTap.WINDOW_MS));
    }

    @Test
    public void disarmStopsFurtherTaps() {
        MicTap tap = new MicTap();
        tap.arm(0);
        tap.disarm();
        assertFalse(tap.isArmed(1));
    }

    @Test
    public void matchesOnlyTheEnableButton() {
        assertTrue(MicTap.isVoiceButton("Enable Voice mode"));
        assertTrue(MicTap.isVoiceButton(" enable voice mode "));
        assertFalse(MicTap.isVoiceButton("Mute Voice mode"));
        assertFalse(MicTap.isVoiceButton("Start dictation"));
        assertFalse(MicTap.isVoiceButton(null));
    }
}
