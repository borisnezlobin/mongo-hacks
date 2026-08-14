# Amelia

Amelia is version control for human context.

Live captions preserve words, but lose who said them, what changed, and what still needs to happen. Amelia is designed first for deaf and hard-of-hearing people navigating fast group conversations.

Amelia attributes utterances to speakers, builds persistent per-person memory, preserves corrections instead of overwriting them, and tracks related promises. In our demo, Maya changes her moving date from September 15 to September 20. Amelia shows both versions, promotes the current date, identifies an affected commitment, and speaks the update aloud.

The technology forms one essential pipeline:

**OpenRouter transcribes the conversation → MongoDB Atlas Vector Search connects voices and memories to people → Fireworks converts speech into structured facts and promises → MongoDB’s append-only supersession graph detects what changed → ElevenLabs gives the update a voice.**

MongoDB Atlas is not simply storage: it connects people, voiceprints, utterances, facts, and promises while preserving their history. Without that temporal graph, Amelia could retrieve old sentences but could not distinguish current context from obsolete context.

Most assistants search recordings. **Amelia understands when the context between people changes—and what that change affects.** The same system could support families, classrooms, care teams, and workplaces where missing one correction can have consequences.
