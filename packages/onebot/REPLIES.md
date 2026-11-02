# Reply targets

A normal OneBot `reply` segment identifies a message by its non-zero, signed
`message_id`. Negative identifiers are valid. The identifier generation rules
for ordinary incoming messages and send results are unchanged.

Private QQ quotes can use a sender-local sequence instead of the conversation
sequence used for message identifiers. SnowLuma checks the conversation, sender
direction, available timestamp and quoted text against stored messages. Matching
numbers from different sequence namespaces do not by themselves prove that two
records identify the same message. The current message is excluded from its own
quote lookup.

When the target is not available locally, live event processing requests bounded
private history before converting and dispatching the event. A verified history
message is stored under its actual identifier, so an immediate `get_msg` can
retrieve it. Existing verified identifiers are preserved when filling a missing
body, and recalled messages are not restored.

An unresolved or ambiguous private target does not produce a guessed identifier
or a new placeholder record. The normal event omits that `reply` segment and
keeps the rest of the message. Warnings identify unresolved targets; trace logs
record the lookup result, conversation, sequence, timestamp and selected
identifier without logging quoted content. Fetch failures remain visible.

Group quotes retain their group-sequence lookup. Forwarded nodes retain their
inline quote content, which can be resent even when the original message is not
available in the local account's history.
