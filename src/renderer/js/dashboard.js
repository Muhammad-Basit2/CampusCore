/**
 * Dashboard - headline figures, fee trend, invoice status, defaulters
 * and the most recent invoices.
 */
'use strict';

const Dashboard = {
  async load() {
    const view = $('#view-dashboard');
    view.innerHTML = '<div class="empty"><span class="spinner"></span> Loading dashboard...</div>';

    const stats = await window.api.dashboard.stats();
    State.settings = stats.settings;

    const maxMonth = Math.max(1, ...stats.feeByMonth.map((m) => Number(m.billed) || 0));
    const rate = stats.billed > 0 ? (stats.collected / stats.billed) * 100 : 0;

    view.innerHTML = `
      <div class="grid cols-4">
        ${stat('Total students', stats.students, `${stats.classes} class${stats.classes === 1 ? '' : 'es'}`, 'accent-brand')}
        ${stat('Subjects', stats.subjects, 'configured for grading')}
        ${stat('Total billed', money(stats.billed), `${pct(rate)} collected`, 'accent-ok')}
        ${stat('Outstanding', money(stats.outstanding), 'awaiting payment', stats.outstanding > 0 ? 'accent-danger' : 'accent-ok')}
      </div>

      <div class="grid cols-2 mt">
        <div class="card">
          <div class="card-head"><h3>Fee Collection by Month</h3></div>
          <div class="card-body">${this.chart(stats.feeByMonth, maxMonth)}</div>
        </div>
        <div class="card">
          <div class="card-head"><h3>Invoice Status</h3></div>
          <div class="card-body">${this.statusBars(stats.byStatus)}</div>
        </div>
      </div>

      <div class="grid cols-2">
        <div class="card">
          <div class="card-head"><h3>Top Defaulters</h3></div>
          <div class="card-body tight">
            <div class="table-wrap">
              <table>
                <thead><tr><th>Roll No</th><th>Student</th><th>Class</th><th class="num">Due</th></tr></thead>
                <tbody>${
                  stats.topDefaulters.length
                    ? stats.topDefaulters
                        .map(
                          (r) => `<tr>
                            <td class="mono">${esc(r.rollNo)}</td>
                            <td>${esc(r.studentName)}</td>
                            <td>${esc(r.studentClass)}</td>
                            <td class="num">${money(r.due)}</td>
                          </tr>`,
                        )
                        .join('')
                    : emptyRow(4, 'No outstanding balances. Well done!', '&#127881;')
                }</tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Recent Invoices</h3></div>
          <div class="card-body tight">
            <div class="table-wrap">
              <table>
                <thead><tr><th>Invoice</th><th>Student</th><th class="num">Amount</th><th>Status</th></tr></thead>
                <tbody>${
                  stats.recentInvoices.length
                    ? stats.recentInvoices
                        .map(
                          (r) => `<tr>
                            <td class="mono">${esc(r.invoiceNo)}</td>
                            <td>${esc(r.studentName)}</td>
                            <td class="num">${money(r.amountDue - r.discount)}</td>
                            <td>${statusBadge(r.status)}</td>
                          </tr>`,
                        )
                        .join('')
                    : emptyRow(4, 'No invoices yet', '&#128203;')
                }</tbody>
              </table>
            </div>
          </div>
        </div>
      </div>`;
  },


  /** Two-tone horizontal bars: billed (ghost) behind collected (brand). */
  chart(months, maxMonth) {
    if (!months.length) return '<div class="empty">No fee data yet.</div>';
    const rows = months.map((m) => {
      const billed = Number(m.billed) || 0;
      const collected = Number(m.collected) || 0;
      const billedWidth = (billed / maxMonth) * 100;
      const collectedWidth = (collected / maxMonth) * 100;
      return `
        <div>
          <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:5px">
            <strong>${esc(m.feeMonth)}</strong>
            <span class="muted">${money(collected)} / ${money(billed)}</span>
          </div>
          <div style="position:relative;height:16px;background:#0e1729;border-radius:8px;overflow:hidden">
            <div style="position:absolute;inset:0;width:${billedWidth}%;background:rgba(79,140,255,.35)"></div>
            <div style="position:absolute;inset:0;width:${collectedWidth}%;background:linear-gradient(90deg,var(--brand),var(--brand-2))"></div>
          </div>
        </div>`;
    });
    return `<div style="display:flex;flex-direction:column;gap:14px">${rows.join('')}</div>`;
  },

  statusBars(byStatus) {
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
    if (!total) return '<div class="empty">No invoices recorded yet.</div>';

    const colors = { Paid: 'var(--ok)', Partial: 'var(--warn)', Unpaid: 'var(--danger)' };
    const bars = Object.entries(byStatus).map(([status, count]) => {
      const share = (count / total) * 100;
      return `
        <div style="margin-bottom:14px">
          <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px">
            <span>${statusBadge(status)}</span>
            <span class="muted">${count} invoice(s) - ${share.toFixed(1)}%</span>
          </div>
          <div style="height:8px;background:#0e1729;border-radius:6px;overflow:hidden">
            <div style="height:100%;width:${share}%;background:${colors[status] || 'var(--brand)'}"></div>
          </div>
        </div>`;
    });
    return `<div>${bars.join('')}</div>`;
  },
};

/** Small KPI tile used by the dashboard header. */
function stat(label, value, foot, accent = '') {
  return `<div class="stat ${accent}">
      <div class="label">${esc(label)}</div>
      <div class="value">${esc(String(value))}</div>
      <div class="foot">${esc(foot)}</div>
    </div>`;
}

