/**
 * Student Attendance view - mark attendance by class and date.
 */
'use strict';

const StudentAttendance = {
  rows: [],
  classId: '',
  studentId: '',
  dateFrom: '',
  dateTo: '',
  _eventRegistry: new WeakMap(),

  async load() {
    const view = $('#view-student-attendance');
    view.innerHTML = '<div class="empty"><span class="spinner"></span> Loading...</div>';

    // Fetch fresh data
    const [classes, students, attendanceRecords] = await Promise.all([
      window.api.classes.list(),
      window.api.students.list(),
      window.api.studentAttendance.list({
        studentId: this.studentId ? Number(this.studentId) : undefined,
        classId: this.classId ? Number(this.classId) : undefined,
        dateFrom: this.dateFrom,
        dateTo: this.dateTo,
      }),
    ]);

    this.classes = classes;
    this.students = students;
    this.currentDate = this.dateFrom || new Date().toISOString().split('T')[0];
    this.classView = !!this.classId;

    // If a class is selected, show ALL students from that class for the date range
    // with their attendance status (or empty if not marked yet)
    if (this.classId) {
      const className = this.classes.find(c => c.id == this.classId)?.name;
      const classStudents = this.students.filter(s => s.studentClass === className);
      const dateRange = this.dateFrom && this.dateTo ? [this.dateFrom, this.dateTo] : [this.currentDate];

      this.rows = [];
      for (const student of classStudents) {
        for (const date of dateRange) {
          // Look in the fresh attendance records
          const existing = attendanceRecords.find(r => r.studentId === student.id && r.date === date);
          if (existing) {
            this.rows.push(existing);
          } else {
            // Create a placeholder row for students without attendance
            this.rows.push({
              id: null,
              studentId: student.id,
              classId: this.classId,
              date: date,
              status: null,
              studentName: student.name,
              rollNo: student.rollNo,
              className: className || '',
            });
          }
        }
      }
      // Sort by student name then date
      this.rows.sort((a, b) => (a.studentName || '').localeCompare(b.studentName || '') || a.date.localeCompare(b.date));
    } else {
      // No class filter - show all attendance records
      this.rows = attendanceRecords;
    }

    this.allRows = [...this.rows];

    // Filter out placeholder rows (null id) for summary calculations
    const realRows = this.rows.filter(r => r.id !== null);
    const placeholderCount = this.rows.length - realRows.length;

    view.innerHTML = `
      <div class="grid cols-4">
        <div class="stat accent-brand" data-kpi-total-container>
          <div class="label">Total Records</div>
          <div class="value" data-kpi-total>${realRows.length}</div>
          <div class="foot">attendance entries</div>
        </div>
        <div class="stat accent-ok" data-kpi-present-container>
          <div class="label">Present</div>
          <div class="value" data-kpi-present>${realRows.filter(r => r.status === 'Present').length}</div>
          <div class="foot">on record</div>
        </div>
        <div class="stat accent-danger" data-kpi-absent-container>
          <div class="label">Absent</div>
          <div class="value" data-kpi-absent>${realRows.filter(r => r.status === 'Absent').length}</div>
          <div class="foot">on record</div>
        </div>
        <div class="stat accent-warn" data-kpi-late-container>
          <div class="label">Late</div>
          <div class="value" data-kpi-late>${realRows.filter(r => r.status === 'Late').length}</div>
          <div class="foot">on record</div>
        </div>
      </div>

      <div class="card mt">
        <div class="card-head">
          <h3>Student Attendance</h3>
          <div class="search-row no-print">
            <select id="sa_class">
              <option value="">All Classes</option>
              ${this.classes.map(c => `<option value="${c.id}"${this.classId == c.id ? ' selected' : ''}>${c.name}</option>`).join('')}
            </select>
            <select id="sa_student">
              <option value="">All Students</option>
            </select>
            <input type="date" id="sa_dateFrom" value="${this.dateFrom}" />
            <span class="muted">to</span>
            <input type="date" id="sa_dateTo" value="${this.dateTo}" />
            <button class="btn" id="sa_refresh">Refresh</button>
            <button class="btn primary" id="sa_mark">Mark Attendance</button>
            <button class="btn primary" id="sa_saveAll" style="display:none">Save All for ${this.currentDate}</button>
          </div>
        </div>
        <div class="card-body tight">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th><th>Student</th><th>Class</th><th>Status</th><th class="actions">Actions</th>
                </tr>
              </thead>
              <tbody>${
                this.rows.length
                  ? this.rows.map((r) => this.row(r)).join('')
                  : emptyRow(5, 'No attendance records found.', '📅')
              }</tbody>
            </table>
          </div>
        </div>
      </div>`;

    const classSelect = $('#sa_class');
    if (classSelect && this.classId) classSelect.value = this.classId;

    await this.populateStudents();
    this.bind(view);
    this.bindKeys();
  },

  bindKeys() {
    Keys.register('student-attendance', {
      n: { keys: 'N', label: 'Mark attendance', run: () => $('#sa_mark').click() },
    });
  },

  getAttendance(studentId, date) {
    return this.rows.find((r) => r.studentId === studentId && r.date === date);
  },
  statusLabel(status) {
    if (!status || status === 'null' || status === 'Null' || status === 'NULL') {
      return 'Not Marked';
    }
    const labels = { Present: 'Present', Absent: 'Absent', Late: 'Late' };
    return labels[status] || status;
  },
  async toggleAttendance(studentId, date, status) {
    try {
      // Single lookup: capture classId and student details before mutation
      const existingRow = this.rows.find((r) => r.studentId === studentId && r.date === date);
      const classId = existingRow?.classId || undefined;
      await window.api.studentAttendance.upsert({ studentId, classId, date, status });

      const studentName = existingRow?.studentName || this.students.find((s) => s.id === studentId)?.name || 'Student';
      const className = existingRow?.className || this.students.find((s) => s.id === studentId)?.studentClass || '';
      const rollNo = existingRow?.rollNo || this.students.find((s) => s.id === studentId)?.rollNo || '';
      notify.ok('Updated', `${studentName}${rollNo ? ` (${rollNo})` : ''} — ${className} — ${date}: ${status}`);

      // Immutable local state mutation: update ONLY the matching row
      this.rows = this.rows.map((item) =>
        item.studentId === studentId && item.date === date ? { ...item, status } : item,
      );

      // Re-render the specific row in the DOM using the composite data-key
      const key = `${studentId}-${date}`;
      const rowEl = document.querySelector(`tr[data-key="${key}"]`);
      const newRowData = this.rows.find((r) => r.studentId === studentId && r.date === date);
      if (rowEl && newRowData) {
        rowEl.outerHTML = this.row(newRowData);
      }

      // Update summary counts based on the deduplicated, immutably-updated array
      this.updateSummary();
    } catch (err) {
      notify.error('Failed', err.message);
    }
  },
  
  updateSummary() {
    // Only count real rows (not placeholders)
    const realRows = this.rows.filter((r) => r.id !== null);
    const total = realRows.length;
    const present = realRows.filter((r) => r.status === 'Present').length;
    const absent = realRows.filter((r) => r.status === 'Absent').length;
    const late = realRows.filter((r) => r.status === 'Late').length;

    const totalEl = document.querySelector('[data-kpi-total]');
    const presentEl = document.querySelector('[data-kpi-present]');
    const absentEl = document.querySelector('[data-kpi-absent]');
    const lateEl = document.querySelector('[data-kpi-late]');
    
    if (totalEl) totalEl.textContent = total;
    if (presentEl) presentEl.textContent = present;
    if (absentEl) absentEl.textContent = absent;
    if (lateEl) lateEl.textContent = late;
  },
  bind(view) {
    const reg = this._eventRegistry;
    delegateOnce(reg, view, 'change', '#sa_class', (e) => {
      this.classId = e.target.value;
      this.load();
    });
    delegateOnce(reg, view, 'change', '#sa_dateFrom', (e) => {
      this.dateFrom = e.target.value;
      this.load();
    });
    delegateOnce(reg, view, 'change', '#sa_dateTo', (e) => {
      this.dateTo = e.target.value;
      this.load();
    });
    delegateOnce(reg, view, 'click', '#sa_refresh', () => this.load());
    delegateOnce(reg, view, 'click', '#sa_mark', () => this.openMarkModal());
    delegateOnce(reg, view, 'click', '#sa_saveAll', async (e) => {
      const btn = e.currentTarget;
      if (btn.disabled) return;
      await this.saveAllForDate();
    });
    delegateOnce(reg, view, 'click', '.att-btn', async (e, btn) => {
      const studentId = Number(btn.dataset.student);
      const date = btn.dataset.date;
      const newStatus = btn.dataset.status;
      const row = btn.closest('tr');
      if (!row) return;
      await this.toggleAttendance(studentId, date, newStatus);
    });
    delegateOnce(reg, view, 'click', '.btn-ghost[data-del]', async (e, btn) => {
      const id = Number(btn.dataset.del);
      if (!id) return;
      // Grab student details from the row before deletion for the toast
      const rowEl = btn.closest('tr');
      const delStudentName = rowEl?.dataset.studentId ? (this.rows.find((r) => r.studentId === Number(rowEl.dataset.studentId) && r.date === rowEl.dataset.date)?.studentName) || 'Student' : 'Student';
      const delDate = rowEl?.dataset.date || '';
      const ok = await confirmDialog({ title: 'Delete attendance', message: 'Delete this attendance record?', confirmText: 'Delete', danger: true });
      if (!ok) return;
      try {
        await window.api.studentAttendance.remove({ id });
        notify.ok('Attendance deleted', `${delStudentName} — ${delDate} — attendance record removed`);
        await this.load();
      } catch (err) {
        notify.error('Failed', err.message);
      }
    });
  },

  row(r) {
    const student = this.students.find((s) => s.id === r.studentId) || {};
    const studentName = r.studentName || student.name || 'Unknown';
    const className = r.className || student.studentClass || '—';
    const dateVal = r.date || this.currentDate;
    const isPlaceholder = r.id === null;
    // Use the row's own status - no need to re-lookup
    const rawStatus = r.status;
    const status = !rawStatus || rawStatus === 'null' || rawStatus === 'Null' ? 'not-marked' : rawStatus.toLowerCase().replace(/\s+/g, '-');
    const key = `${r.studentId}-${dateVal}`;

    return `
      <tr data-key="${key}" data-student-id="${r.studentId}" data-date="${dateVal}">
        <td>${dateVal}</td>
        <td><strong>${esc(studentName)}</strong>${student.rollNo ? `<br><span class="muted" style="font-size:12px">${esc(student.rollNo)}</span>` : ''}</td>
        <td>${esc(className)}</td>
        <td>
          <span class="badge ${status}" data-status-badge>${this.statusLabel(rawStatus)}</span>
        </td>
        <td class="actions">
          <button class="btn-sm att-btn att-present${status === 'present' ? ' active' : ''}" data-student="${r.studentId}" data-date="${dateVal}" data-status="Present" title="Mark Present">✓ P</button>
          <button class="btn-sm att-btn att-absent${status === 'absent' ? ' active' : ''}" data-student="${r.studentId}" data-date="${dateVal}" data-status="Absent" title="Mark Absent">✗ A</button>
          ${!isPlaceholder ? `<button class="btn-sm btn-ghost" data-del="${r.id}" title="Delete">🗑</button>` : ''}
        </td>
      </tr>`;
  },

  async save(close) {
    const studentId = Number($('#mark_sa_student').value);
    const date = $('#mark_sa_date').value.trim();
    const status = $('#mark_sa_status').value;

    if (!studentId || !date || !status) {
      notify.warn('Missing fields', 'Please fill in all fields.');
      return;
    }

    try {
      // Get the classId from the selected class in the modal
      const classSelect = $('#mark_sa_class');
      const classId = classSelect ? Number(classSelect.value) : this.classId ? Number(this.classId) : undefined;
      await window.api.studentAttendance.upsert({ studentId, classId, date, status });
      const studentName = this.students.find(s => s.id === studentId)?.name || String(studentId);
      notify.ok('Attendance saved', `${studentName} — ${date}: ${status}`);
      close();
      await this.load();
    } catch (err) {
      notify.error('Failed', err.message);
    }
  },

  async populateStudents() {
    const students = await window.api.students.list();
    const select = $('#sa_student');
    if (!select) return;
    select.innerHTML = '<option value="">All Students</option>';
    const classSelect = document.getElementById('sa_class');
    const selectedClassName = classSelect?.options[classSelect.selectedIndex]?.text || '';
    const filtered = this.classId
      ? students.filter(s => s.studentClass === selectedClassName)
      : students;
    filtered.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.name} (${s.rollNo})`;
      select.appendChild(opt);
    });
  },

  async openMarkModal() {
    const classes = await window.api.classes.list();
    if (!classes.length) {
      notify.warn('No classes', 'Please add classes first.');
      return;
    }

    await openModal((close) =>
      el('div', { class: 'modal' }, [
        el('div', { class: 'modal-head' }, [
          el('h3', { text: 'Mark Student Attendance' }),
          el('button', { class: 'btn ghost sm', text: 'Close', onClick: close }),
        ]),
        el('div', { class: 'modal-body' }, [
          el('div', { class: 'form-grid' }, [
            el('div', { class: 'field full' }, [
              el('label', { for: 'mark_sa_class', text: 'Class' }),
              el('select', { id: 'mark_sa_class' },
                classes.map((c) => el('option', { value: c.id, text: c.name }))
              ),
            ]),
            el('div', { class: 'field full' }, [
              el('label', { for: 'mark_sa_student', text: 'Student' }),
              el('select', { id: 'mark_sa_student' },
                el('option', { value: '', text: 'Select a student...' })
              ),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'mark_sa_date', text: 'Date' }),
              el('input', { id: 'mark_sa_date', type: 'date', value: new Date().toISOString().split('T')[0] }),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'mark_sa_status', text: 'Status' }),
              el('select', { id: 'mark_sa_status' }, [
                el('option', { value: 'Present', text: 'Present' }),
                el('option', { value: 'Absent', text: 'Absent' }),
                el('option', { value: 'Late', text: 'Late' }),
              ]),
            ]),
          ]),
        ]),
        el('div', { class: 'modal-foot' }, [
          el('button', { class: 'btn ghost', text: 'Cancel', onClick: close }),
          el('button', {
            class: 'btn primary',
            text: 'Save',
            onClick: (e) => withBusy(e.currentTarget, () => this.save(close)),
          }),
        ]),
      ]),
    );

    const students = await window.api.students.list();
    const studentSelect = $('#mark_sa_student');
    if (studentSelect) {
      studentSelect.innerHTML = '';
      students.forEach((s) => {
        studentSelect.appendChild(el('option', { value: s.id, text: `${s.name} (${s.rollNo})` }));
      });
    }
  },

  async saveAllForDate() {
    if (!this.currentDate) {
      notify.warn('No date', 'Select a date first.');
      return;
    }
    const date = this.currentDate;
    const rows = Array.from(document.querySelectorAll('#view-student-attendance tbody tr'));
    let saved = 0;
    let failed = 0;
    for (const row of rows) {
      const studentId = Number(row.dataset.studentId);
      const presentBtn = row.querySelector('.att-btn[data-status="Present"]');
      if (!presentBtn) continue;
      const status = presentBtn.classList.contains('active') ? 'Present' : 'Absent';
      try {
        await window.api.studentAttendance.upsert({ studentId, classId: Number(this.classId), date, status });
        saved++;
      } catch {
        failed++;
      }
    }
    if (failed > 0) {
      notify.warn('Partial save', `${saved} saved, ${failed} failed.`);
    } else {
      notify.ok('Attendance saved', `${saved} students marked for ${date}`);
    }
    await this.load();
  },
};