# Run Validation in Backend Sandboxes

Capture Path Validation will run as backend jobs in isolated Daytona sandboxes, not inside the web server process, the user's browser, Docker-specific infrastructure, or a local-only CLI architecture. We chose this because validating a prepared app and generated capture path means executing untrusted code, can take minutes, produces job artifacts such as logs and screenshots, and should share the same execution model that Footage Capture uses.
