# Setting up plan updates from Claude

This adds the ability to update your training plan by talking to Claude, instead of
opening the app. Four things to do, roughly 15 minutes. Nothing here needs code.

Do them in order — step 4 won't work until 1–3 are done.

---

## 1. Make an API key

This is the password that stops anyone else writing to your plan.

Use your password manager's generator and make a key that is:

- **at least 40 characters**
- **letters and numbers only** — no symbols, no spaces (it goes in a web address, and
  symbols break that)

Save it in your password manager. You'll paste it in twice: once into Render, once into
Claude. Nowhere else.

---

## 2. Update the database

Go to Supabase → your project → **SQL Editor** → **New query**.

**First**, open `schema.sql` from the repo, copy the whole file, paste it in, hit **Run**.
It's safe to run on your existing database — it only adds the new tables and columns and
leaves everything already there untouched.

**Then**, do the same with `seed_plan.sql`. That loads your 12-week plan into the database
(84 sessions, 27 Jul to 18 Oct). It's also safe to re-run later — it refreshes the session
descriptions but won't undo any reschedules you've made.

To check it worked: Table Editor → you should see a new `plan_sessions` table with 84 rows,
and an empty `change_log` table.

---

## 3. Add the key to Render

Go to Render → your `stride` service → **Environment** → **Add Environment Variable**.

- **Key:** `STRIDE_API_KEY`
- **Value:** the key you generated in step 1

Save. Render will redeploy on its own, which takes a couple of minutes. Wait for the status
to go back to **Live** before moving on.

> If you skip this step the write endpoints return "STRIDE_API_KEY is not set on the server"
> and refuse every change — deliberately, so the plan can't be edited without a key.

---

## 4. Add the connector in Claude

Claude → **Settings** → **Connectors** → **Add custom connector**.

- **Name:** `Stride`
- **URL:**

  ```
  https://stride-lrdq.onrender.com/mcp/PASTE-YOUR-KEY-HERE
  ```

  Replace `PASTE-YOUR-KEY-HERE` with the key from step 1, keeping the rest exactly as-is.
  So it ends up looking like `https://stride-lrdq.onrender.com/mcp/x7Kd92...`

Leave the OAuth fields blank. Save, then start a new conversation — the Stride tools only
appear in chats opened after the connector is added.

**Why the key is in the address:** Claude's custom connector screen only gives you one box,
for the URL, so that's where the key has to go. The server also accepts it as a normal
authorisation header, which is what other tools would use. Practical consequences: don't
paste that full URL into a browser or share it, and treat it like a password. If it ever
leaks, change `STRIDE_API_KEY` in Render to a new value and update the connector — that
instantly invalidates the old one.

---

## Checking it works

Start a new conversation and try:

> What's on my training plan this week?

Then something that writes:

> Mark Tuesday as a niggle — left calf was tight.

Open the app afterwards and the niggle and the note should be there.

**The first message of the day may be slow.** Render's free tier puts the service to sleep
after about 15 minutes of no traffic, and waking it takes 30–60 seconds. If Claude says the
connector timed out, just ask again — the second attempt lands on a woken-up server.

---

## What Claude can and can't do

**Can:**

- Read the plan for any date range, including what you've already logged
- Mark a session hit / niggle / missed, with notes
- Move a session to another date, or change its type
- Show you a log of every change it has made

**Can't:**

- Change anything without the key
- Move a session outside the 27 Jul – 18 Oct block
- Silently move a session into a different week or training phase

That last one is deliberate. If a move would shift load into a different week, cross a phase
boundary, or drop a hard session into a cutback or taper week, the change **does not happen**.
Claude gets the warning back and has to put it to you in plain language first. Say go ahead
and it applies; say no and nothing changed. For example:

> **You:** Move Sunday's long run to Monday.
>
> **Claude:** That moves the 26km long run out of week 7 into week 8, which is your
> cutback and decision-gate week — the one your plan notes call load-bearing. Still want to?
>
> **You:** Yeah, I'm away Sunday.
>
> **Claude:** Done, moved to 14 Sept.

Moves inside the same week, and simple type swaps in a normal build week, just happen without
the extra question.

---

## If something needs undoing

Every write is recorded with a timestamp, what changed, and the before/after values. Ask:

> Show me what's been changed in the plan recently.

You'll get the list, including anything you confirmed through a warning (marked as an
override). Then tell Claude to put it back — it has the old values and can reverse it.

You can also see the raw record in Supabase → Table Editor → `change_log`.

---

## Setting a passcode

Without this, the app is currently locked for everyone, including you — it fails locked
rather than open. Takes about 2 minutes, no GitHub experience needed beyond copy and paste.

**Important: I (Claude) never see your passcode.** The tool below turns it into a
scrambled fingerprint entirely inside your own browser — that's the only thing that ever
leaves the page.

1. Open <https://jackkay22.github.io/stride/passcode-tool.html>
2. Type a passcode of your choosing, click **Generate**
3. Click **Copy** — it copies one line of text, something like
   `window.STRIDE_PASSCODE_HASH = "a1b2c3...";`
4. Go to <https://github.com/jackkay22/stride/blob/main/passcode.js>
5. Click the pencil (✏️) icon, top right of the file, to edit it
6. Select everything in the box and paste over it with what you copied
7. Scroll down, click **Commit changes**

A minute or two later the site rebuilds and your passcode is live. To change it later,
just repeat these steps with a new passcode.

**How it behaves:**

- Opened in a normal browser (Safari, Chrome, etc.), the app asks for the passcode once.
  After that it's remembered on that device and won't ask again there.
- Once added to your phone's home screen (see below), it never asks at all — installing
  it is treated as proof it's your own device.
- If you ever forget the passcode, there's no recovery flow — just generate a new one and
  repeat the steps above. Anyone already unlocked on their own device stays unlocked; this
  only affects devices that haven't entered it yet.

This is a light gate, not real security — worth understanding what it does and doesn't do.
It stops someone stumbling onto your GitHub Pages link from seeing your training data at a
glance. It would not stop someone who deliberately opened your browser's developer tools.
The passcode is never stored anywhere retrievable — not on GitHub, not by Claude — only its
scrambled fingerprint is, in `passcode.js`, which is fine to be public since it can't be
reversed back into the real passcode. `passcode-tool.html` isn't linked from the app itself;
you only need it when setting or changing your passcode, so there's no need to bookmark it.

---

## Installing Stride on your phone

The app can now be added to a home screen and opens full-screen, with its own icon —
no app store involved. Nothing to set up on your end beyond the install itself.

**iPhone (Safari — it must be Safari, Chrome on iOS can't do this):**

1. Open <https://jackkay22.github.io/stride/>
2. Tap the Share button (the square with the arrow)
3. Scroll down, tap **Add to Home Screen**, then **Add**

**Android (Chrome):**

1. Open <https://jackkay22.github.io/stride/>
2. Either tap the **Install** prompt if it appears, or open the ⋮ menu and tap
   **Install app** / **Add to Home screen**

Once installed it runs without the browser address bar. If you open it with no signal
the app itself still loads, but the sessions won't — the training data always comes from
the backend, deliberately, so it can't show you a stale plan.

**After a redeploy:** the app checks for a new version each time you open it, so changes
appear on next launch. If it ever looks stuck on an old version, close it fully and reopen.

---

## Running the tests (optional)

If you ever want to check nothing's broken, from the repo folder:

```bash
npm install && npm test
```

29 tests covering the date handling, the write rules, the phase warnings, the Coach Jack
quick-action presets, and the connector. They run against an in-memory fake, so they never
touch your real data.
