package com.sfrut.nflpicks

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private val Navy = Color(0xFF013369)

/**
 * Who this phone belongs to, whether notifications are on, and - on the
 * admin's phone only - a box for messaging the whole group.
 */
class SettingsActivity : ComponentActivity() {

    private lateinit var prefs: Prefs
    private var notificationsOn by mutableStateOf(false)

    private val askNotifications =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { refreshNotifications() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        refreshNotifications()
        setContent {
            val dark = isSystemInDarkTheme()
            MaterialTheme(
                colorScheme = if (dark) darkColorScheme(primary = Color(0xFF7FA7E0))
                else lightColorScheme(primary = Navy)
            ) {
                Surface(Modifier.fillMaxSize()) { SettingsScreen() }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        refreshNotifications()
    }

    private fun refreshNotifications() {
        notificationsOn = NotificationManagerCompat.from(this).areNotificationsEnabled()
    }

    private fun turnOnNotifications() {
        val permissionMissing = Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        // The system only shows the permission prompt so many times; after the
        // first refusal, or with notifications switched off in system settings,
        // the system screen is the only way back on.
        if (permissionMissing && !prefs.askedForNotifications) {
            prefs.askedForNotifications = true
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
            return
        }
        startActivity(
            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
        )
    }

    @Composable
    private fun SettingsScreen() {
        var picker by remember { mutableStateOf(prefs.picker) }

        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Text("Settings", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)

            Section("Who are you?") {
                Text(
                    "The site opens as this picker on this phone.",
                    style = MaterialTheme.typography.bodySmall
                )
                PICKERS.forEach { name ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .selectable(selected = picker == name, onClick = {
                                picker = name
                                prefs.picker = name
                            })
                            .padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        RadioButton(selected = picker == name, onClick = null)
                        Text(name, Modifier.padding(start = 12.dp), style = MaterialTheme.typography.bodyLarge)
                    }
                }
            }

            Section("Notifications") {
                when {
                    !NflPicksApp.pushConfigured -> Text(
                        "This build of the app has no notification service set up yet.",
                        style = MaterialTheme.typography.bodyMedium
                    )
                    notificationsOn -> Text(
                        "On. Messages to the group will appear on this phone.",
                        style = MaterialTheme.typography.bodyMedium
                    )
                    else -> {
                        Text("Off. You will not see messages to the group.", style = MaterialTheme.typography.bodyMedium)
                        Button(onClick = { turnOnNotifications() }) { Text("Turn on notifications") }
                    }
                }
            }

            if (picker == ADMIN_PICKER) AdminSection()

            Button(
                onClick = { finish() },
                enabled = picker != null,
                modifier = Modifier.fillMaxWidth()
            ) { Text(if (picker == null) "Choose a picker first" else "Done") }

            Text(
                "Version ${packageManager.getPackageInfo(packageName, 0).versionName}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }

    @Composable
    private fun AdminSection() {
        var key by remember { mutableStateOf(prefs.adminKey) }
        var title by remember { mutableStateOf("NFL Picks") }
        var body by remember { mutableStateOf("") }
        var sending by remember { mutableStateOf(false) }
        var status by remember { mutableStateOf<String?>(null) }
        val scope = rememberCoroutineScope()

        Section("Message the group") {
            Text(
                "Goes to every phone with the app and notifications on.",
                style = MaterialTheme.typography.bodySmall
            )
            OutlinedTextField(
                value = key,
                onValueChange = { key = it; prefs.adminKey = it },
                label = { Text("Admin key") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                modifier = Modifier.fillMaxWidth()
            )
            OutlinedTextField(
                value = title,
                onValueChange = { title = it },
                label = { Text("Title") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )
            OutlinedTextField(
                value = body,
                onValueChange = { body = it },
                label = { Text("Message") },
                minLines = 3,
                modifier = Modifier.fillMaxWidth()
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedButton(
                    enabled = !sending && key.isNotBlank() && body.isNotBlank(),
                    onClick = {
                        sending = true
                        status = null
                        scope.launch {
                            val error = withContext(Dispatchers.IO) {
                                Notify.send(key.trim(), title.ifBlank { "NFL Picks" }, body.trim())
                            }
                            sending = false
                            status = error ?: "Sent."
                            if (error == null) body = ""
                        }
                    }
                ) { Text(if (sending) "Sending..." else "Send to the group") }
            }
            status?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
        }
    }

    @Composable
    private fun Section(heading: String, content: @Composable () -> Unit) {
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(heading, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                content()
            }
        }
        Spacer(Modifier.height(0.dp))
    }
}
