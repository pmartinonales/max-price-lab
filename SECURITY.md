# Security policy

Max Price Lab is a local, single-user app with no login. Run it on your own machine only. The tunnel you open for webhooks makes the whole app reachable, not just `/webhook`, so keep the tunnel URL private and stop the tunnel when you're done.

## Reporting a vulnerability

Please don't open a public issue. Report it privately instead: open the repository's **Security** tab and choose **Report a vulnerability**.

Include what you found, how to reproduce it and what it could expose. You'll get a reply as soon as the maintainers can look at it.

If you accidentally posted an API key or access token anywhere public, revoke it with your provider first (360dialog Hub or Meta Business Settings), then let us know.
