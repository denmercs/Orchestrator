package dev.denmercs.jarvis;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.SystemClock;
import android.provider.Settings;
import android.widget.Toast;

/** The home-screen icon: opens Paseo with voice mode about to be turned on, then gets out of the way. */
public class JarvisActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (!JarvisService.isRunning()) {
            Toast.makeText(this, R.string.enable_service, Toast.LENGTH_LONG).show();
            startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
        } else {
            Intent paseo = getPackageManager().getLaunchIntentForPackage(MicTap.PASEO);
            if (paseo == null) {
                Toast.makeText(this, R.string.no_paseo, Toast.LENGTH_LONG).show();
            } else {
                JarvisService.TAP.arm(SystemClock.elapsedRealtime());
                startActivity(paseo);
            }
        }
        finish();
    }
}
