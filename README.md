# Moodle Hub

Your own replacement for the Moodle website. It runs on one computer, checks Moodle every 15 minutes, and gives you:

- **Today:** what's due, with countdowns and a Submit button
- **Courses:** every file and activity, organized by section. Files open on your phone.
- **Updates:** course announcements
- **Grades:** grades as they're posted
- **Push notifications** for new assignments, changed deadlines, announcements, new material and grades
- **Reminders** 24 hours and 3 hours before anything you haven't submitted
- **Your own tasks**, for deadlines that aren't in Moodle (like ProblemChat homework)

Everything stays on your computer. Nothing is sent anywhere except Moodle itself, your notifications, and, only if you turn on summaries, the text of new course files to Anthropic's API.

## 1. Install Python (once)

- **Windows:** install Python 3 from python.org. In the installer, tick **"Add python.exe to PATH"**.
- **Mac:** Python 3 is usually already there. If not, install it from python.org.
- **Linux / Raspberry Pi:** already installed.

Optional, for file summaries: `pip install pypdf`

## 2. Start it

- **Windows:** double-click `start-windows.bat`
- **Mac:** double-click `start-mac.command`. The first time, right-click it and choose Open.
- **Linux:** run `./start-linux.sh`

A window opens and shows the addresses. Leave it open.

## 3. Set it up (on the computer, once)

Open **http://localhost:8765** in Chrome or Edge on that computer, and follow the setup page:

1. **Connect Moodle.** Sign in to Moodle in Chrome or Edge, then click "Copy sign-in link". Open a new empty tab, press F12 (Mac: ⌥⌘J) to open the console, then paste the link into the address bar and press Enter. The console shows a red line containing `moodlemobile://token=…`. Copy that part and paste it into the setup page. If there's no red line, open the Network tab, click `launch.php`, and copy the `location` response header instead.
2. **Choose a passcode** for your phone.
3. **Notifications:** install the free **ntfy** app on your phone and subscribe to the topic the setup page shows you. Tap "Send a test notification" to check it works.
4. **Your phone:** with your phone on the same Wi-Fi, open the address shown (like `http://192.168.1.20:8765`). Enter your passcode, then use **Share → Add to Home Screen** so it opens like an app.

## Keep it always on

The Hub only syncs while the computer is on and the window is open.

- **Turn off sleep:** Windows: Settings → System → Power → Sleep: Never (when plugged in). Mac: System Settings → Battery/Energy → Prevent automatic sleeping. The screen can still turn off.
- **Start it automatically when the computer turns on:**
  - **Windows:** press Win+R, type `shell:startup`, and drag a shortcut to `start-windows.bat` into that folder.
  - **Mac:** System Settings → General → Login Items → add `start-mac.command`.
  - **Linux / Raspberry Pi:** run `./start-linux.sh --install-service` once.

An old laptop or a Raspberry Pi left plugged in is ideal.

## Use it anywhere, not just at home

Away from home, your phone can't reach your home computer by default. The easiest fix is **Tailscale**, which is free and takes about 5 minutes:

1. Install Tailscale on the computer and on your phone, and sign in to both with the same account.
2. On the phone, open `http://<computer-name>:8765`. Tailscale shows the computer's name or `100.x.x.x` address.
3. Put that address in the Hub's Settings under "Hub address for notifications", so tapping a notification opens your Hub.

Notifications work anywhere without Tailscale. Tailscale is only needed to open the Hub itself away from home.

## If something goes wrong

- **"Moodle sign-in expired":** you'll get a notification. Open Settings on the computer and repeat the sign-in step under "Reconnect Moodle".
- **The phone can't connect:** check the phone is on the same Wi-Fi, and allow Python through the firewall if Windows asks.
- **Summaries:** add an Anthropic API key in Settings and run `pip install pypdf`. Summaries are written for new material automatically. For older files, tap "Summarize".

## Files

- `hub.py`: the whole program (Python standard library only)
- `static/`: the phone interface
- `data/`: your settings, database and downloaded files. Delete this folder to start over.
