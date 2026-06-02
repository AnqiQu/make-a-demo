# Run Repo Validation in Backend Sandboxes

Repo validation will run as backend jobs in isolated Docker sandboxes, not inside the web server process, the user's browser, or a local-only CLI architecture. We chose this because validating a submitted repo means executing untrusted code, can take minutes, produces job artifacts such as logs and screenshots, and should share the same execution model that later footage-capture jobs will use.
