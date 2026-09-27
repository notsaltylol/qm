import { createPostgresTpmStore } from "../src/tpm/postgres-tpm-store.ts";
import { tpmStoreContract } from "./support/tpm-store-contract.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the pg tpm-store tests";

tpmStoreContract("postgres", (now) => createPostgresTpmStore(URL!, { now }), skip);
