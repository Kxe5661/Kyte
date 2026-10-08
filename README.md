# Kyte

Your personal AI assistant. Kyte runs on your Mac, controls it on your behalf
(open apps, run commands, manage files, drive apps with AppleScript), and takes
commands from your iPhone through a chat interface. Risky actions require a tap
of approval on your phone before they run.

## Setup (one time, ~5 minutes)

1. **Get a free Gemini API key** at <https://aistudio.google.com/apikey>.

2. **Configure:**
   ```sh
   cp .env.example .env
   ```
   Open `.env` and paste your key into `GEMINI_API_KEY=`.

3. **Install and start:**
   ```sh
   npm install
   npm start
   ```
   The terminal prints the address for your iPhone and your password.

4. **On your iPhone** (same Wi-Fi as the Mac): open the printed address in
   Safari, enter the password, then tap Share → **Add to Home Screen** to make
   Kyte feel like a real app.

5. **Permissions:** the first time Kyte controls an app via AppleScript, macOS
   will pop up a permission dialog on the Mac — click OK. For UI-level control,
   grant your terminal app access in System Settings → Privacy & Security →
   Accessibility. For the Live Screen view, allow Screen Recording for your
   terminal when macOS asks (System Settings → Privacy & Security → Screen
   Recording), then restart Kyte.

## Using Kyte

Just tell it what you want:

- "Open Spotify and play my Discover Weekly"
- "What's eating my disk space?"
- "Make a folder on my Desktop called Taxes and move any PDFs with 'invoice' in the name into it"
- "Set volume to 30%"

Shell commands, AppleScript, and file writes show an **Approve / Deny** card on
your phone before they run. Read-only actions run automatically.

**Live Screen:** tap **Live** in the header to watch your Mac's screen in real
time from your phone while Kyte works.

**Memory:** Kyte remembers lasting facts you share (preferences, routines,
form details) in `data/memory.md` — a plain text file you can open and edit.
Conversations also survive restarts (`data/state.json`); tap **New** to start
fresh.

## Away from home?

Install [Tailscale](https://tailscale.com) (free) on both the Mac and the
iPhone, then use the Mac's Tailscale IP instead of the Wi-Fi IP. Your traffic
is encrypted end-to-end and nothing is exposed to the public internet.

## Configuration

Everything lives in `.env`:

| Variable | Meaning |
|---|---|
| `GEMINI_API_KEY` | Your API key (free tier is fine) |
| `GEMINI_MODEL` | Model to use; see what your key offers at `http://localhost:3171/api/models?auth=YOUR_PASSWORD` |
| `PORT` | Server port (default 3171) |
| `KYTE_PASSWORD` | Phone login password (auto-generated on first run if blank) |
