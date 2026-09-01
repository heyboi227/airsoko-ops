# Recorded entries

What an operator made through the application, as seed data. One file per entity,
written by the API after every committed change and replayed by `npm run db:seed` and
by the API as it starts. Commit them. Decision 32 in `docs/DECISIONS.md` has the
reasoning.

- A file holds the row as it stands now, not the change that produced it, plus the
  children that only make sense beside it: a cabin's seats, a flight's timeline.
- A file with `"deleted": true` is a tombstone. The entry was removed through the
  application, and the seed must not put it back.
- To change or remove an entry, use the application. Editing a file by hand works,
  because the replay is an upsert, but nothing checks it until the next replay.
- A merge conflict in one of these files means both machines changed the same entry.
  Keep the version that is right, remove the markers, and restart the API.
