# Validate Browser Interaction, Not Just Server Start

Repo validation succeeds only when MakeADemo can load the submitted app in a browser, verify that the page is responsive and interactable, capture proof such as a screenshot, and avoid obvious fatal runtime states like blank pages or framework error screens. We chose this over treating a started dev server as sufficient because demo generation depends on browser-capturable product behavior, but feature exploration belongs to a later stage rather than validation.
