/**
 * The claim P1-5 exists to make good on: adding an adapter is three lines plus a harness, and the
 * suite does not change to admit it. If this file ever needs more than this, the port is not the
 * seam it is documented to be.
 */

import { jsonfileHarness } from "./jsonfile.harness.ts";
import { runUsageSourceContract } from "./usage-source.contract.ts";

runUsageSourceContract(jsonfileHarness);
