/**
 * Students view - searchable roster, create/edit/delete and the handover
 * into the fee module for a given student.
 */
'use strict';

const Students = {
  rows: [],
  search: '',

  async load() {
    const view = $('#view-students');
    view.innerHTML = '<div class="empty"><span class="spinner"></span> Loading students...</div>';

    this.rows = await window.api.students.list(this.search);

    view.innerHTML = `
      <div class="grid cols-4">
        ${kpi('Total students', this.rows.length, 'records in the roster', 'accent-brand')}
        ${kpi('Classes', new Set(this.rows.map((r) => r.studentClass)).size, 'distinct classes')}
        ${kpi('With invoices', this.rows.filter((r) => r.invoiceCount > 0).length, 'students billed at least once')}
        ${kpi('Total outstanding', money(this.rows.reduce((a, r) => a + Number(r.dueAmount), 0)), 'across the roster', 'accent-danger')}
      </div>

      <div class="card mt">
        <div class="card-head">
          <h3>Roster</h3>
          <div class="search-row no-print">
            <input type="search" id="studentSearch" placeholder="Search name, roll no or class..."
                   value="${esc(this.search)}" />
            <button class="btn primary" id="addStudent">+ New student</button>
          </div>
        </div>
        <div class="card-body tight">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Roll No</th><th>Name</th><th>Class</th><th>Guardian</th><th>Phone</th>
                  <th class="num">Invoices</th><th class="num">Due</th><th class="actions">Actions</th>
                </tr>
              </thead>
              <tbody>${
                this.rows.length
                  ? this.rows.map((r) => this.row(r)).join('')
                  : emptyRow(8, this.search ? 'No students match your search.' : 'No students yet. Add your first student.', '&#128101;')
              }</tbody>
            </table>
          </div>
        </div>
      </div>`;

    this.bind(view);
  },

  row(r) {
    const due = Number(r.dueAmount);
    return `<tr data-id="${r.id}">
      <td class="mono">${esc(r.rollNo)}</td>
      <td><strong>${esc(r.name)}</strong></td>
      <td>${esc(r.studentClass)}</td>
      <td>${esc(r.guardian) || '<span class="muted">-</span>'}</td>
      <td class="mono">${esc(r.phone) || '<span class="muted">-</span>'}</td>
      <td class="num">${r.invoiceCount}</td>
      <td class="num">${due > 0 ? `<span style="color:var(--warn)">${money(due)}</span>` : '<span class="muted">0.00</span>'}</td>
      <td class="actions no-print">
        <button class="btn sm" data-act="fee" data-id="${r.id}">Fees</button>
        <button class="btn sm" data-act="edit" data-id="${r.id}">Edit</button>
        <button class="btn sm danger" data-act="delete" data-id="${r.id}">Delete</button>
      </td>
    </tr>`;
  },

  bind(view) {
    const search = $('#studentSearch', view);
    let timer = null;
    search.addEventListener('input', (e) => {
      clearTimeout(timer);
      const value = e.target.value;
      timer = setTimeout(async () => {
        this.search = value;
        await this.load();
        const box = $('#studentSearch');
        if (box) {
          box.focus();
          box.setSelectionRange(box.value.length, box.value.length);
        }
      }, 220);
    });

    $('#addStudent', view).addEventListener('click', () => this.openForm());

    on(view, 'click', 'button[data-act]', async (e, btn) => {
      const student = this.rows.find((r) => r.id === Number(btn.dataset.id));
      if (!student) return;
      if (btn.dataset.act === 'fee') {
        Nav.go('fees', { studentId: student.id });
      } else if (btn.dataset.act === 'edit') {
        this.openForm(student);
      } else if (btn.dataset.act === 'delete') {
        await this.remove(student);
      }
    });
  },

  /* ------------------------------------------------------------------ */
  /* Create / edit                                                       */
  /* ------------------------------------------------------------------ */

  openForm(existing = null) {
    const editing = existing && existing.id;
    const classes = [...new Set(this.rows.map((r) => r.studentClass))].sort();

    openModal((close) =>
      el('div', { class: 'modal' }, [
        el('div', { class: 'modal-head' }, [
          el('h3', { text: editing ? `Edit ${existing.name}` : 'New Student' }),
        ]),
        el('div', { class: 'modal-body' }, [
          el('div', { class: 'form-grid' }, [
            el('div', { class: 'field' }, [
              el('label', { for: 's_rollNo', text: 'Roll No' }),
              el('input', { id: 's_rollNo', value: editing ? existing.rollNo : '', maxlength: '40' }),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 's_name', text: 'Full name' }),
              el('input', { id: 's_name', value: editing ? existing.name : '', maxlength: '120' }),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 's_class', text: 'Class' }),
              el('input', {
                id: 's_class',
                value: editing ? existing.studentClass : '',
                maxlength: '60',
                list: 'classOptions',
              }),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 's_guardian', text: 'Guardian name' }),
              el('input', {
                id: 's_guardian',
                value: editing ? existing.guardian || '' : '',
                maxlength: '120',
              }),
            ]),
            el('div', { class: 'field full' }, [
              el('label', { for: 's_phone', text: 'Phone' }),
              el('input', {
                id: 's_phone',
                value: editing ? existing.phone || '' : '',
                maxlength: '40',
                placeholder: 'e.g. +92 300 1234567',
              }),
            ]),
            editing
              ? el('div', { class: 'field full' }, [
                  el('div', { class: 'kv' }, [
                    el('span', { class: 'k', text: 'Invoices' }),
                    el('span', { class: 'v', text: String(existing.invoiceCount) }),
                    el('span', { class: 'k', text: 'Outstanding' }),
                    el('span', { class: 'v', text: money(existing.dueAmount) }),
                  ]),
                ])
              : null,
          ]),
          el('datalist', { id: 'classOptions' }, classes.map((c) => el('option', { value: c }))),
        ]),
        el('div', { class: 'modal-foot' }, [
          el('button', { class: 'btn ghost', text: 'Cancel', onClick: close }),
          el('button', {
            class: 'btn primary',
            text: editing ? 'Save changes' : 'Add student',
            onClick: (e) => withBusy(e.currentTarget, () => this.submit(existing, close)),
          }),
        ]),
      ]),
    );

    const first = editing ? $('#s_name') : $('#s_rollNo');
    if (first) first.focus();
  },

  async submit(existing, close) {
    const val = (id) => ($(id) ? $(id).value.trim() : '');
    const payload = {
      rollNo: val('#s_rollNo'),
      name: val('#s_name'),
      studentClass: val('#s_class'),
      guardian: val('#s_guardian'),
      phone: val('#s_phone'),
    };

    if (!payload.rollNo) {
      notify.warn('Roll No required', 'Please enter the student roll number.');
      $('#s_rollNo').focus();
      return;
    }
    if (!payload.name) {
      notify.warn('Name required', 'Please enter the student name.');
      $('#s_name').focus();
      return;
    }
    if (!payload.studentClass) {
      notify.warn('Class required', 'Please enter the class.');
      $('#s_class').focus();
      return;
    }

    if (existing && existing.id) {
      await window.api.students.update({ id: existing.id, ...payload });
      notify.ok('Student updated', payload.name + ' has been saved.');
    } else {
      await window.api.students.create(payload);
      notify.ok('Student added', payload.name + ' is now on the roster.');
    }
    close();
    await this.load();
  },

  async remove(student) {
    const ok = await confirmDialog({
      title: 'Delete student',
      message: 'Delete ' + student.name + ' (' + student.rollNo + ')?',
      detail:
        student.invoiceCount > 0
          ? 'This student has ' + student.invoiceCount + ' invoice(s). Their invoices stay in the database but are no longer linked.'
          : 'This action cannot be undone.',
      confirmText: 'Delete student',
      danger: true,
    });
    if (!ok) return;
    await window.api.students.remove(student.id);
    notify.ok('Student deleted', student.name + ' has been removed from the roster.');
    await this.load();
  },
};
