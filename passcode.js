/* Stride's access passcode — kept in its own file so you can change it yourself
   any time via GitHub's "edit" (pencil) button, without touching index.html.

   This does NOT contain your actual passcode. It holds a one-way "hash" — a
   scrambled fingerprint of it. The app checks whatever's typed in by scrambling
   it the same way and comparing the result; it never stores the real passcode
   anywhere. To set or change yours, open passcode-tool.html (see SETUP.md),
   type a passcode, and paste the line it gives you over the one below.

   Left blank, the app stays locked for everyone, including you — this is
   deliberate: an unconfigured passcode fails closed, not open. */
window.STRIDE_PASSCODE_HASH = "e515e0d62b7b38241fc0233b3cb3957c489f15a59c0af893c1318ece99da0b32";
