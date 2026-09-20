# Sentinel stall on pilot.example.org (Slack thread, 2026-05-14)

[09:14] <@U04AB12CD>: Watchdog flagged pilot.example.org this morning: the sentinel backlog climbed from about 300 to over 900 in six hours and nothing else moved.
[09:16] Ada (hosting): Checking. The API is fine, outbound push backlog is flat at zero, uptime unchanged.
[09:31] Ada (hosting): The sentinel log shows the same transition error every few seconds: accept_patient_reports throws on a form field added in yesterday's upgrade.
[09:40] <@U04AB12CD>: So every new report gets requeued and the backlog grows until someone fixes the transition config.
[10:05] Ada (hosting): Disabled the transition, backlog draining now, ops@example.org notified. Will re-enable after the config fix.
[10:20] <@U04AB12CD>: Noted for next time: a sentinel backlog that rises steadily for hours after an upgrade while the API stays healthy usually means a transition is throwing.
