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

Image uploads retain their download reference and actual filename in durable
message metadata. `get_msg` refreshes each image from that message's own reference,
so a reused filename or a restart does not select another upload.

For older records missing an image reference, `get_msg` requests bounded history
for the stored conversation and sequence (or the stored timestamp and client
sequence for legacy private records). Only a unique message with matching sender,
time and ordered image fingerprints can fill the missing references. The repair
is saved under the existing signed `message_id`; it preserves message content
and identity metadata and never restores a record removed while the request was pending.
Complete images need no history request. If history is unavailable or cannot
verify the match, the unverified image data is left intact and a warning is logged;
download URLs are not guessed.
