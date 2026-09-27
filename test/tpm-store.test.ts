import { createMemoryTpmStore } from "../src/tpm/memory-tpm-store.ts";
import { tpmStoreContract } from "./support/tpm-store-contract.ts";

tpmStoreContract("memory", (now) => createMemoryTpmStore({ now }));
