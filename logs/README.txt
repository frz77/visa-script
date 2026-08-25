Visa Bot session logs are written to this folder by captcha-relay.js.

Each browser-tab session uses one readable file named:
visa-session-YYYY-MM-DD_HH-MM-SS_xxxxxx.log

The generated .log files are ignored by Git.

Entries use a compact event format for long-session analysis, for example:
[19:35:52] slots.wait
[19:35:58] slots.available count=2
