package com.sfrut.nflpicks

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// ---------------------------------------------------------------------------
// The site's look, in Compose. Colours are styles.css's :root and
// [data-theme="dark"] tokens; type is Inter, as on the site.
// ---------------------------------------------------------------------------

private val Inter = FontFamily(
    Font(R.font.inter_400, FontWeight.Normal),
    Font(R.font.inter_500, FontWeight.Medium),
    Font(R.font.inter_600, FontWeight.SemiBold),
    Font(R.font.inter_700, FontWeight.Bold),
    Font(R.font.inter_800, FontWeight.ExtraBold),
    Font(R.font.inter_900, FontWeight.Black)
)

private data class SiteColors(
    val page: Color,        // --bg-secondary
    val card: Color,        // --bg-primary
    val hover: Color,       // --bg-hover
    val text: Color,        // --text-primary
    val textSecondary: Color,
    val textLight: Color,
    val border: Color,      // --border-color
    val green: Color,       // --accent-green
    val red: Color,         // --accent-red
    val button: Color,      // .btn-primary background
)

private val LightColors = SiteColors(
    page = Color(0xFFF8F9FA), card = Color.White, hover = Color(0xFFF0F1F3),
    text = Color(0xFF0A0A0A), textSecondary = Color(0xFF4A4A4A), textLight = Color(0xFF6B7280),
    border = Color(0xFFE5E7EB), green = Color(0xFF059669), red = Color(0xFFDC2626),
    button = Color(0xFF0A0A0A)
)

private val DarkColors = SiteColors(
    page = Color(0xFF0A0A0A), card = Color(0xFF111111), hover = Color(0xFF252525),
    text = Color(0xFFF5F5F5), textSecondary = Color(0xFFA3A3A3), textLight = Color(0xFF737373),
    border = Color(0xFF2A2A2A), green = Color(0xFF10B981), red = Color(0xFFEF4444),
    button = Color(0xFF013369)
)

private val HeaderBlack = Color(0xFF0A0A0A)   // --bg-dark
private val NflBlue = Color(0xFF013369)       // --nfl-blue

private val LocalSite = staticCompositionLocalOf { LightColors }

/** `.picker-selector label`: small, uppercase, letter-spaced, grey. */
@Composable
private fun Label(text: String, modifier: Modifier = Modifier) {
    Text(
        text.uppercase(), modifier,
        style = TextStyle(
            fontFamily = Inter, fontWeight = FontWeight.SemiBold, fontSize = 12.sp,
            letterSpacing = 0.08.em, color = LocalSite.current.textSecondary
        )
    )
}

@Composable
private fun Body(text: String, color: Color = LocalSite.current.textSecondary, size: TextUnit = 14.sp) {
    Text(text, style = TextStyle(fontFamily = Inter, fontSize = size, lineHeight = 20.sp, color = color))
}

/** A card, as the week and picker selectors: 8dp corners, a 1dp border. */
@Composable
private fun Card(content: @Composable () -> Unit) {
    val site = LocalSite.current
    Column(
        Modifier
            .fillMaxWidth()
            .background(site.card, RoundedCornerShape(8.dp))
            .border(1.dp, site.border, RoundedCornerShape(8.dp))
            .padding(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) { content() }
}

/** `.btn .btn-primary`: black, square-ish, uppercase. */
@Composable
private fun PrimaryButton(text: String, enabled: Boolean = true, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val site = LocalSite.current
    Box(
        modifier
            .background(if (enabled) site.button else site.border, RoundedCornerShape(4.dp))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 28.dp, vertical = 14.dp),
        contentAlignment = Alignment.Center
    ) {
        Text(
            text.uppercase(),
            style = TextStyle(
                fontFamily = Inter, fontWeight = FontWeight.SemiBold, fontSize = 14.sp,
                letterSpacing = 0.05.em, color = if (enabled) Color.White else site.textLight
            )
        )
    }
}

/** An input in the site's dropdown style: a 2dp border, 4dp corners, label above. */
@Composable
private fun Field(
    label: String, value: String, onChange: (String) -> Unit,
    secret: Boolean = false, lines: Int = 1
) {
    val site = LocalSite.current
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Label(label)
        BasicTextField(
            value = value,
            onValueChange = onChange,
            singleLine = lines == 1,
            minLines = lines,
            visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
            keyboardOptions = if (secret) KeyboardOptions(keyboardType = KeyboardType.Password) else KeyboardOptions.Default,
            textStyle = TextStyle(fontFamily = Inter, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, color = site.text),
            cursorBrush = SolidColor(site.text),
            modifier = Modifier
                .fillMaxWidth()
                .background(site.card, RoundedCornerShape(4.dp))
                .border(2.dp, site.border, RoundedCornerShape(4.dp))
                .padding(horizontal = 14.dp, vertical = 12.dp)
        )
    }
}

/**
 * Who this phone belongs to, whether notifications are on, and - on the
 * admin's phone only - a box for messaging the whole group. Styled as the site
 * is, so stepping out of it into Settings does not feel like another app.
 */
class SettingsActivity : ComponentActivity() {

    companion object {
        /** In: the page's Odds API credits line, for the admin tools. */
        const val EXTRA_QUOTA = "quota"
        /** Out: an admin action for MainActivity to have the page run. */
        const val EXTRA_ADMIN_ACTION = "adminAction"
        /** The actions the page's runAppAdminAction() knows. */
        val ADMIN_ACTIONS = setOf("refresh-spreads", "export-picks")
    }

    private lateinit var prefs: Prefs
    private var notificationsOn by mutableStateOf(false)

    /** Close Settings and have the site run one of its admin actions. */
    private fun runOnSite(action: String) {
        setResult(RESULT_OK, Intent().putExtra(EXTRA_ADMIN_ACTION, action))
        finish()
    }

    private val askNotifications =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { refreshNotifications() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        refreshNotifications()
        // Draw behind the bars: the black header runs up under the status bar.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        // The page runs under the navigation bar too, so its buttons need to be
        // dark on the light page and light on the dark one.
        window.navigationBarColor = android.graphics.Color.TRANSPARENT
        setContent {
            val dark = isSystemInDarkTheme()
            val view = LocalView.current
            SideEffect {
                WindowCompat.getInsetsController(window, view).isAppearanceLightNavigationBars = !dark
            }
            CompositionLocalProvider(LocalSite provides if (dark) DarkColors else LightColors) {
                SettingsScreen()
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
        val site = LocalSite.current
        var picker by remember { mutableStateOf(prefs.picker) }
        // First launch: the screen is a welcome, not a settings page.
        val firstRun = remember { prefs.picker == null }
        var showAdmin by remember { mutableStateOf(false) }

        // Admin Settings is a page of its own; back returns to this one.
        BackHandler(enabled = showAdmin) { showAdmin = false }
        if (showAdmin) {
            AdminScreen(onBack = { showAdmin = false })
            return
        }

        Column(
            Modifier
                .fillMaxSize()
                .background(site.page)
        ) {
            Header(if (firstRun) "Welcome" else "App Settings")

            Column(
                Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .navigationBarsPadding()
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                Text(
                    "WHO ARE YOU?",
                    style = TextStyle(fontFamily = Inter, fontWeight = FontWeight.Black, fontSize = 22.sp,
                        letterSpacing = 0.01.em, color = site.text),
                    modifier = Modifier.padding(top = 8.dp)
                )
                Body("The site opens as this picker on this phone. You can still look at anyone's picks.")

                Card {
                    Label("Picks for")
                    PICKERS.forEach { name ->
                        PickerOption(name, selected = picker == name) {
                            picker = name
                            prefs.picker = name
                        }
                    }
                }

                Card {
                    Label("Notifications")
                    when {
                        !NflPicksApp.pushConfigured ->
                            Body("This build of the app has no notification service set up.")
                        notificationsOn -> StatusLine(on = true, "On. Messages to the group appear on this phone.")
                        else -> {
                            StatusLine(on = false, "Off. You won't see messages to the group.")
                            PrimaryButton("Turn on notifications") { turnOnNotifications() }
                        }
                    }
                }

                // Anyone can choose Stephen - there are no logins - so the
                // admin page asks for the admin key before it shows anything.
                if (picker == ADMIN_PICKER) {
                    Card {
                        Label("Admin")
                        Body(
                            if (prefs.adminUnlocked) "Spreads, export and messaging the group."
                            else "Needs the admin key."
                        )
                        PrimaryButton("Admin Settings  ›", modifier = Modifier.fillMaxWidth()) {
                            showAdmin = true
                        }
                    }
                }

                PrimaryButton(
                    if (picker == null) "Choose a picker first" else if (firstRun) "Let's go" else "Done",
                    enabled = picker != null,
                    modifier = Modifier.fillMaxWidth()
                ) { finish() }

                Text(
                    "VERSION ${packageManager.getPackageInfo(packageName, 0).versionName}",
                    style = TextStyle(fontFamily = Inter, fontWeight = FontWeight.SemiBold, fontSize = 11.sp,
                        letterSpacing = 0.12.em, color = site.textLight),
                    modifier = Modifier.align(Alignment.CenterHorizontally).padding(bottom = 8.dp)
                )
            }
        }
    }

    /** The site's header: black, the shield, a heavy uppercase title, a green line under it. */
    @Composable
    private fun Header(subtitle: String) {
        Row(
            Modifier
                .fillMaxWidth()
                .background(HeaderBlack)
                .drawBehind {
                    // header { border-bottom: 3px solid var(--nfl-blue) }
                    val y = size.height - 1.5.dp.toPx()
                    drawLine(NflBlue, Offset(0f, y), Offset(size.width, y), 3.dp.toPx())
                }
                .statusBarsPadding()
                .padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 19.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Image(painterResource(R.drawable.nfl_shield), contentDescription = "NFL", Modifier.size(44.dp))
            Spacer(Modifier.width(16.dp))
            Column {
                Text(
                    "NFL PICKS DASHBOARD",
                    style = TextStyle(fontFamily = Inter, fontWeight = FontWeight.Black, fontSize = 20.sp,
                        letterSpacing = 0.02.em, color = Color.White)
                )
                Text(
                    subtitle.uppercase(),
                    style = TextStyle(fontFamily = Inter, fontWeight = FontWeight.Bold, fontSize = 12.sp,
                        letterSpacing = 0.12.em, color = Color(0xFF10B981)),
                    modifier = Modifier.padding(top = 4.dp)
                )
            }
        }
    }

    /** One picker, as a selectable row: a 2dp border that goes dark and gains a tick when chosen. */
    @Composable
    private fun PickerOption(name: String, selected: Boolean, onClick: () -> Unit) {
        val site = LocalSite.current
        Row(
            Modifier
                .fillMaxWidth()
                .background(if (selected) site.hover else site.card, RoundedCornerShape(4.dp))
                .border(BorderStroke(2.dp, if (selected) site.text else site.border), RoundedCornerShape(4.dp))
                .clickable(onClick = onClick)
                .padding(horizontal = 16.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                name,
                Modifier.weight(1f),
                style = TextStyle(fontFamily = Inter, fontSize = 16.sp,
                    fontWeight = if (selected) FontWeight.Bold else FontWeight.SemiBold, color = site.text)
            )
            if (selected) {
                Text("✓", style = TextStyle(fontFamily = Inter, fontWeight = FontWeight.Black,
                    fontSize = 18.sp, color = site.green))
            }
        }
    }

    @Composable
    private fun StatusLine(on: Boolean, text: String) {
        val site = LocalSite.current
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(10.dp).background(if (on) site.green else site.red, RoundedCornerShape(5.dp)))
            Spacer(Modifier.width(10.dp))
            Body(text, color = site.text)
        }
    }

    /**
     * The admin actions that used to sit under Stephen's picks. Each closes
     * Settings and runs on the site, which shows its own progress and result.
     */
    @Composable
    private fun AdminToolsCard() {
        val quota = remember { intent.getStringExtra(EXTRA_QUOTA).orEmpty() }
        Card {
            Label("Admin tools")
            Body(
                if (quota.isNotBlank()) quota
                else "Odds API credits show once the site has fetched odds."
            )
            PrimaryButton("Refresh spreads from API", modifier = Modifier.fillMaxWidth()) {
                runOnSite("refresh-spreads")
            }
            PrimaryButton("Export all picks", modifier = Modifier.fillMaxWidth()) {
                runOnSite("export-picks")
            }
            Body("Both run on the site and report there. Export copies this week's picks for WhatsApp.")
        }
    }

    /**
     * Admin Settings: the admin tools and messaging the group, behind the
     * admin key. The key is checked against a SHA-256 built into the APK
     * (Prefs.isAdminKey), so the page opens for nobody who merely picked
     * Stephen. Once a correct key is in, this phone stays unlocked.
     */
    @Composable
    private fun AdminScreen(onBack: () -> Unit) {
        val site = LocalSite.current
        var unlocked by remember { mutableStateOf(prefs.adminUnlocked) }

        Column(
            Modifier
                .fillMaxSize()
                .background(site.page)
        ) {
            Header("Admin Settings")
            Column(
                Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .navigationBarsPadding()
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                Text(
                    "‹  BACK",
                    style = TextStyle(fontFamily = Inter, fontWeight = FontWeight.Bold, fontSize = 13.sp,
                        letterSpacing = 0.08.em, color = site.textSecondary),
                    modifier = Modifier.clickable(onClick = onBack).padding(vertical = 4.dp)
                )

                if (!unlocked) {
                    UnlockCard(onUnlocked = { unlocked = true })
                } else {
                    AdminToolsCard()
                    AdminCard()
                    Text(
                        "LOCK ADMIN ON THIS PHONE",
                        style = TextStyle(fontFamily = Inter, fontWeight = FontWeight.SemiBold, fontSize = 12.sp,
                            letterSpacing = 0.08.em, color = site.textLight),
                        modifier = Modifier
                            .align(Alignment.CenterHorizontally)
                            .clickable {
                                prefs.adminKey = ""
                                unlocked = false
                            }
                            .padding(8.dp)
                    )
                }
            }
        }
    }

    @Composable
    private fun UnlockCard(onUnlocked: () -> Unit) {
        val site = LocalSite.current
        var key by remember { mutableStateOf("") }
        var wrong by remember { mutableStateOf(false) }
        Card {
            Label("Admin key")
            Body("Admin Settings is for Stephen only. Enter the admin key to open it on this phone.")
            Field("Key", key, { key = it; wrong = false }, secret = true)
            PrimaryButton("Unlock", enabled = key.isNotBlank(), modifier = Modifier.fillMaxWidth()) {
                if (prefs.isAdminKey(key)) {
                    prefs.adminKey = key
                    onUnlocked()
                } else {
                    wrong = true
                }
            }
            if (wrong) StatusLine(on = false, "That key isn't right.")
        }
    }

    @Composable
    private fun AdminCard() {
        val site = LocalSite.current
        val key = remember { prefs.adminKey }
        var title by remember { mutableStateOf("NFL Picks") }
        var body by remember { mutableStateOf("") }
        var sending by remember { mutableStateOf(false) }
        var status by remember { mutableStateOf<Pair<Boolean, String>?>(null) }
        val scope = rememberCoroutineScope()

        Card {
            Label("Message the group")
            Body("Goes to every phone with the app and notifications on.")
            Field("Title", title, { title = it })
            Field("Message", body, { body = it }, lines = 3)
            PrimaryButton(
                if (sending) "Sending..." else "Send to the group",
                enabled = !sending && key.isNotBlank() && body.isNotBlank(),
                modifier = Modifier.fillMaxWidth()
            ) {
                sending = true
                status = null
                scope.launch {
                    val error = withContext(Dispatchers.IO) {
                        Notify.send(key.trim(), title.ifBlank { "NFL Picks" }, body.trim())
                    }
                    sending = false
                    status = if (error == null) true to "Sent." else false to error
                    if (error == null) body = ""
                }
            }
            status?.let { (ok, text) -> StatusLine(on = ok, text) }
            Spacer(Modifier.height(0.dp))
        }
    }
}
