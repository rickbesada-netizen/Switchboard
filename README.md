# Switchboard

One inbox for WhatsApp, Messenger and Instagram on your PC, plus quiet posting to Instagram profiles.

## What it does
- **One inbox**: every connected account in one list. Filter by app, account, tag, unread, pinned or archived. Search across all saved messages.
- **Ghost read** (on by default): read without sending "Seen". The chat stays unread on the other app until you reply or press *Mark as read on ...* in the chat's info panel. Can be changed per chat.
- **Hide typing** (on by default): never shows "typing..." to the other person. Can be changed per chat.
- **Keeps deleted messages**: if someone unsends a message, your saved copy stays, marked *Deleted by sender*.
- **Edit history**: click *edited* on a message to see every version.
- **Seen indicators**: shows when they've read *your* messages.
- **Multiple accounts per app, each with its own proxy**: every account runs in its own engine, so client accounts never share an IP.
- **Works on its own**: Messenger and Instagram log in through Switchboard's own login window. Each account has its own private browser session that goes through that account's proxy. *Open browser* on an account lets you browse the site as that account.
- **Optional Trickster connection**: turn on *Settings → Connect to Trickster* to link an account to a Trickster profile. Its login and Instagram posting then run inside that profile, through Trickster's local API on port 53200.
- **Post screen** for Instagram posts, Instagram stories, Facebook posts and Facebook stories, on your profile or any Facebook Page you manage, with a *Test* button that goes up to the final Share/Post click and then stops, plus scheduling:
  - *Instagram posts*: "Post quietly to profile" (Instagram's own option) keeps a post out of followers' feeds.
  - *Instagram stories*: Everyone, or Close Friends only. Uses Instagram's phone site, because the desktop site can't post stories.
  - *Facebook posts*: Public, Friends, Friends except..., Specific friends..., or Only me. Facebook has no "quiet" option, so the audience is how you keep a post low-key. Page posts are public.
  - *Facebook stories*: Public, Friends, or Custom (chosen people). Photos only, because Facebook's website doesn't take video stories.
  - Facebook posting uses your *Facebook / Messenger* accounts, which share the same Facebook login. Add Pages by pasting their link under *Post as → Add a Page*.
- **Folders across every app**: sort chats from WhatsApp, Messenger and Instagram into folders like Personal, Business and Church (a chat can be in several). Right-click a chat, drag it onto a folder, or use its info panel. Inside a folder you can narrow by app, and inside an app you can narrow by folder. Accounts can file their new chats into a folder automatically (*Accounts → Edit*).
- **Hidden chats**: hide a chat and it disappears from every list and unread count, showing only under *Folders → Hidden*, with an optional passcode and muted notifications.
- **Messenger encrypted history**: most Messenger chats are end-to-end encrypted. When you log in, Switchboard asks for your 6-digit Messenger backup PIN so it can load their history.
- **Agency tools**: quick replies (type `/`), auto-replies (keywords, hours, cooldown, per account), private notes per chat, send later, and chat export (TXT/CSV/JSON).
- Replies, reactions, editing and unsending your own messages, files, photos, video and voice notes, drag and drop.

## Download
- **Windows**: https://github.com/rickbesada-netizen/Switchboard/releases/latest/download/Switchboard-Setup.exe. It installs with desktop and Start menu shortcuts, starts with Windows in the tray, and updates itself: new versions download in the background and a "Restart to update" button appears.
- **Android**: https://github.com/rickbesada-netizen/Switchboard/releases/latest/download/Switchboard.apk. Sign in with your Switchboard account and everything is there: accounts, chats, folders and posting, with message notifications. The app tells you when a new version is out.

Windows may show "Windows protected your PC" because the installer isn't code-signed: click *More info → Run anyway*. On Android, allow installing from your browser when asked.

Every push to `main` builds the engine, the Windows installer and the Android app on GitHub Actions and publishes them as the latest release.

## Setup
1. Download and run **Switchboard-Setup.exe** (link above). There's nothing else to install.
2. Go to **Accounts → Add an account**:
   - **WhatsApp**: scan the QR code with your phone (*Settings → Linked devices → Link a device*).
   - **Messenger / Instagram**: enter the account's proxy (optional), press *Add and log in*, and log in in the window that opens. It closes by itself once you're in. If Trickster is connected (*Settings*), you can pick a Trickster profile instead, or paste exported cookies.

## Your Switchboard account
Sign in with the same Switchboard account on every PC and phone (*Settings → Switchboard account*). The first time, choose *Create account* on one device; only one account can ever be created, and it's yours.
- **One PC runs your accounts.** The highest PC on your list (*Settings → Switchboard account → PCs*, reorder with the arrows) that's switched on runs WhatsApp, Messenger and Instagram. When a higher PC (say your laptop) comes online, the other one hands over: it stops its engines, uploads an encrypted copy of everything (chats, logins, settings), and the laptop picks up from there within about a minute. *Run accounts on this PC* forces a handover straight away.
- **Every other device is a window onto that PC.** On the same network (or Tailscale) it connects straight to it; anywhere else it goes through your private Switchboard relay. If no PC is on, the phone shows "PC offline" until one is.
- **Encrypted with your password.** Copies uploaded for a handover are encrypted on the PC with a key made from your password, so they can't be read without it. If you forget the password, the online copies can't be recovered (your PC still has its own).
- Without signing in, Switchboard works exactly as before, on that PC only.

## Run it 24/7 on a free server
So your accounts stay connected when your PCs are off, run Switchboard on a free Oracle Cloud server (Always Free, Ubuntu, Ampere/Arm, 2 cores and 12 GB):
1. Create the server (Ubuntu image, Ampere shape), then connect to it with SSH.
2. Run `curl -fsSL https://github.com/rickbesada-netizen/Switchboard/releases/latest/download/install-server.sh | sudo bash` and sign in with your Switchboard account when asked.
3. It goes to the top of your PC list, so it takes over your accounts from whichever PC has them (encrypted handover, same as between PCs). Your PCs and phone connect to it through your private relay.

It updates itself every night. Logs: `journalctl -u switchboard -f`. Sign in again: `sudo switchboard-signin`.
- To add a Messenger or Instagram account (which needs a login window), paste its cookies, or press *Run accounts on this PC* on your laptop, add it there, and the server takes everything back afterwards. WhatsApp QR codes work from any device.
- Meta is more suspicious of logins from data-centre addresses, so give every account a proxy (WhatsApp included).

## How it works
- Each account runs in its own small built-in engine (`engine.exe`, bundled inside Switchboard). It's built from the open-source mautrix bridge code (WhatsApp, Messenger including encrypted chats, and Instagram) and talks straight to the app. There's no Docker and no server.
- Each engine uses that account's proxy, so client accounts never share an IP.
- Switchboard saves every message to `%APPDATA%\Switchboard\data` as it arrives. That saved copy is what keeps deleted messages and edit history. Keep Switchboard running in the tray (the default when you close the window): while it's fully quit, accounts aren't connected, and they catch up when it reopens.
- Ghost read works because the engine only sends a read receipt when you ask for one.
- Instagram posting without Trickster opens Chrome (or Edge, which comes with Windows) with that account's saved login and proxy.

## Building from source
- `engine/` is a Go program. GitHub Actions builds it (`.github/workflows/build.yml`), puts it into the Electron app, and publishes Switchboard.exe on every push to `main`.
- To run from source: build the engine into `engine/bin/engine.exe` (or download the `engine` artifact from a workflow run), then run `npm install` and `npm start` (or **Start-Switchboard.bat**).

## Good to know
- These bridges are unofficial logins. Meta can flag them, especially Instagram. Try a spare account first, and give each client account the same proxy it normally uses.
- WhatsApp uses one of your four linked-device slots. Your phone does not need to stay online. A handover between PCs keeps the same linked device, so it never asks you to scan again.
- Logs: *Accounts → Log* shows each account's engine log. App log: `%APPDATA%\Switchboard\data\logs`.
- *Post quietly to profile* is still rolling out on Instagram's side. If an account doesn't have it, Switchboard stops before sharing, unless you turn on *Post normally if this account doesn't have the quiet option*.
