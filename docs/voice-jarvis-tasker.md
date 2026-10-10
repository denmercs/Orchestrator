# Hey Jarvis

Start Paseo's own voice mode from an Android phone's home screen, or by saying "Hey Jarvis" while Paseo
is open. Everything runs on the phone: Tasker opens Paseo and taps its mic as a finger would. No
Tailscale, no voice token, and no plugin code. Paseo connects to the Mac the way it always does.

Paseo has no link or plugin API that starts voice mode, and plugins can't use the mic, so the tap is
done through Android accessibility. If a Paseo update moves or relabels the mic button, redo the click
in step 2.

## 1. Install

From the Play Store: Tasker, AutoInput and AutoVoice (joaoapps). Open AutoInput and AutoVoice once and
turn on their Accessibility service.

## 2. Task: Tap Paseo mic

Open Paseo on the agent you talk to, then in Tasker create the task `Tap Paseo mic`:

1. Plugin → AutoVoice → Continuous → Stop. Paseo needs the mic to itself once voice starts.
2. Plugin → AutoInput → Action. Use the helper to pick Paseo's mic button; action **Click**.

Switch to Paseo and run it. Voice mode should start.

## 3. Task: Jarvis

One tap from the home screen to Paseo listening. Create the task `Jarvis`:

1. Launch App → Paseo.
2. Wait → 1 second.
3. Perform Task → `Tap Paseo mic`.

Add a Tasker **Task Shortcut** widget for `Jarvis` to the home screen.

## 4. "Hey Jarvis" while Paseo is open

- Profile → Application → Paseo.
  - Entry task: AutoVoice → Continuous → Start.
  - Exit task: AutoVoice → Continuous → Stop. Listening, and its battery cost, stays limited to
    Paseo being in front.
- Profile → Event → Plugin → AutoVoice → Recognized, commands `hey jarvis` and `jarvis`, task
  `Tap Paseo mic`.

Once voice mode starts, "Hey Jarvis" is off until you leave Paseo and come back.

## Keep it in the repo

After it works, export the project from Tasker (long-press the project tab → Export → As XML) and
commit it here as `docs/tasker/Jarvis.prj.xml`, so it can be imported on a new phone with Tasker →
Import Project. Plugin actions keep their settings in the export, but the AutoInput click is tied to
Paseo's current screen, so check step 2 after importing.
