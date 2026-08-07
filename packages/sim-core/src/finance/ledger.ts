/**
 * ledger@1, part two: applying transactions to cash and proving the books
 * balance. The audit invariant (DATA_CONTRACT.md §5): for every company,
 * cash == initial + Σin − Σout. auditLedger reports problems instead of
 * throwing — an audit that crashes on the corruption it exists to find is
 * useless.
 */

import type { CompanyId, CompanyState, Transaction } from "@kayfabe/sim-contract";
import { addCents, assertCents, formatUSD } from "../money";

/**
 * Mutates company.cashCents: direction "in" adds, "out" subtracts.
 * Transactions for another company or with non-positive amounts are ledger
 * corruption and throw.
 */
export function applyTransactions(company: CompanyState, txs: Transaction[]): void {
  for (const tx of txs) {
    if (tx.companyId !== company.id) {
      throw new Error(`ledger: transaction ${tx.id} belongs to ${tx.companyId}, not ${company.id}`);
    }
    assertCents(tx.amountCents, `transaction ${tx.id}`);
    if (tx.amountCents <= 0) {
      throw new Error(`ledger: transaction ${tx.id} must have a positive amount, got ${tx.amountCents}`);
    }
    company.cashCents = addCents(
      company.cashCents,
      tx.direction === "in" ? tx.amountCents : -tx.amountCents,
    );
  }
}

/**
 * Verifies every company's cash equals initial + Σin − Σout over the ledger.
 * Returns problem descriptions; empty array = balanced.
 */
export function auditLedger(
  companies: Record<CompanyId, CompanyState>,
  ledger: Transaction[],
  initialCash: Record<CompanyId, number>,
): string[] {
  const errors: string[] = [];
  const net = new Map<CompanyId, number>();

  for (const tx of ledger) {
    if (!Number.isSafeInteger(tx.amountCents) || tx.amountCents <= 0) {
      errors.push(`transaction ${tx.id}: amountCents must be positive integer cents, got ${tx.amountCents}`);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(companies, tx.companyId)) {
      errors.push(`transaction ${tx.id}: unknown company ${tx.companyId}`);
      continue;
    }
    net.set(
      tx.companyId,
      (net.get(tx.companyId) ?? 0) + (tx.direction === "in" ? tx.amountCents : -tx.amountCents),
    );
  }

  for (const companyId of Object.keys(companies).sort()) {
    const company = companies[companyId]!;
    const initial = initialCash[companyId];
    if (initial === undefined) {
      errors.push(`company ${companyId}: no initial cash recorded`);
      continue;
    }
    if (!Number.isSafeInteger(initial)) {
      errors.push(`company ${companyId}: initial cash must be integer cents, got ${initial}`);
      continue;
    }
    if (!Number.isSafeInteger(company.cashCents)) {
      errors.push(`company ${companyId}: cashCents must be integer cents, got ${company.cashCents}`);
      continue;
    }
    const expected = addCents(initial, net.get(companyId) ?? 0);
    if (company.cashCents !== expected) {
      errors.push(
        `company ${companyId}: cash ${formatUSD(company.cashCents)} != initial + net ${formatUSD(expected)}`,
      );
    }
  }

  return errors;
}
