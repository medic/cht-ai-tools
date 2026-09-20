# Sentinel

Sentinel is the CHT service that processes changes after they are written to the database. It runs
transitions: small pieces of logic that update a document, schedule messages, register a patient or
mark a report as accepted. Each change waits in a queue until every configured transition has run.

The sentinel backlog is the number of changes still waiting. A healthy deployment keeps it near
zero or at a small steady level that reflects how fast users are writing. When a transition throws
on a document it cannot handle, the change is retried and the queue grows until the transition is
fixed or disabled. When the database is under heavy load the queue grows too, but it drains again
once the load passes.

What matters is the shape: a steady rise over hours that does not drain points at a stuck
transition; a rise and fall within a day usually follows a burst of activity such as a training or
a reporting deadline.
