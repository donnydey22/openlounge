// One-time import of an existing db.json into Postgres. Stop the server first.
//   DATABASE_URL=postgres://… npm run db:import              (defaults to $DATA_DIR/db.json)
//   DATABASE_URL=postgres://… npm run db:import -- ./old/db.json
// Merges on top of what's already in Postgres (users/sessions by id, DMs de-duplicated by id).
// Note: a fresh, empty Postgres database imports $DATA_DIR/db.json automatically at server boot.
import { DATA_FILE } from "../server/persistence";
import { store } from "../server/store";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set — nothing to import into.");
  process.exit(1);
}
const file = process.argv[2] || DATA_FILE;
store
  .init({ importJson: file })
  .then(() => store.close())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
