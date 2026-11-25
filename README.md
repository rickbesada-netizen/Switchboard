# Switchboard

One inbox for WhatsApp, Messenger and Instagram on your PC, plus quiet posting to Instagram profiles.

## What it does
- **One inbox**: every connected account in one list. Filter by app, account, tag, unread, pinned or archived. Search across all saved messages.
- **Ghost read** (on by default): read without sending "Seen". The chat stays unread on the other app until you reply or press *Mark as read on ...* in the chat's info panel. Can be changed per chat.
- **Hide typing** (on by default): never shows "typing..." to the other person. Can be changed per chat.
- **Keeps deleted messages**: if someone unsends a message, your saved copy stays, marked *Deleted by sender*.
- **Edit history**: click *edited* on a message to see every version.
- **Seen indicators**: shows when they've read *your* messages.
- **Multiple accounts per app, each with its own proxy**: every account runs in its own bridge container, so client accounts never share an IP.
- **Works on its own**: Messenger and Instagram log in through Switchboard's own login window. Each account has its own private browser session that goes through that account's proxy. *Open browser* on an account lets you browse the site as that account.
- **Optional Trickster connection**: turn on *Settings → Connect to Trickster* to link an account to a Trickster profile. Its login and Instagram posting then run inside that profile, through Trickster's local API on port 53200.
- **Post to Instagram quietly**: posts to the profile grid using Instagram's own *Post quietly to profile* option, so the post stays out of followers' home feeds. Has a *Test* button that checks whether an account has the option without posting anything. You can post now or schedule it.
- **Agency tools**: quick replies (type `/`), auto-replies (keywords, hours, cooldown, per account), tags, private notes per chat, send later, and chat export (TXT/CSV/JSON).
- Replies, reactions, editing and unsending your own messages, files, photos, video and voice notes, drag and drop.

## Download
**https://github.com/rickbesada-netizen/Switchboard/releases/latest/download/Switchboard.exe**: click it and the latest Switchboard.exe downloads. No install needed. Windows may show "Windows protected your PC" because the exe isn't code-signed; click *More info → Run anyway*.

Every push to `main` builds a new exe through GitHub Actions and publishes it as the latest release, so the link above always gets the newest version.

## Setup (once)
1. Install **Docker Desktop** (https://www.docker.com/products/docker-desktop/) and open it. In its settings, tick *Start Docker Desktop when you sign in*.
2. Download and open **Switchboard.exe** (link above). To run from source instead, install Node.js LTS and double-click **Start-Switchboard.bat**.
3. In Switchboard, press **Start engine**. The first start downloads the server and bridges (about 400 MB).
4. Go to **Accounts → Add an account**:
   - **WhatsApp**: scan the QR code with your phone (*Settings → Linked devices → Link a device*).
   - **Messenger / Instagram**: enter the account's proxy (optional), press *Add and log in*, and log in in the window that opens. It closes by itself once you're in. If Trickster is connected, you can pick a Trickster profile instead. You can also paste exported cookies.

To build a single **Switchboard.exe**, double-click **Build-Exe.bat** (the exe ends up in `dist`).

## How it works
- **Engine** = a private Matrix server (Synapse) plus one mautrix bridge per account, all in Docker and listening only on 127.0.0.1. It keeps running in Docker even when Switchboard is closed, so new messages are not missed.
- **Switchboard** = the desktop app. It saves every message to `%APPDATA%\Switchboard\data` as it arrives. That saved copy is what keeps deleted messages and edit history. Leave Switchboard in the tray (the default when you close the window) so messages are saved before anyone can unsend them.
- Instagram posting without Trickster opens Chrome (or Edge, which comes with Windows) with that account's saved login and proxy.
- Ghost read works because Switchboard never sends a read receipt to the bridge unless you ask it to.

## Good to know
- These bridges are unofficial logins. Meta can flag them, especially Instagram. Try a spare account first, and give each client account the same proxy it normally uses.
- WhatsApp uses one of your four linked-device slots. Your phone does not need to stay online.
- *Post quietly to profile* is still rolling out on Instagram's side. If an account doesn't have it, Switchboard stops before sharing, unless you turn on *Post normally if this account doesn't have the quiet option*.
- If a bridge moves to a new Docker image tag, change it under *Settings → Advanced*.
- Logs: *Accounts → Log* (per bridge), and *Engine → Server log*. App log: `%APPDATA%\Switchboard\data\logs`.
