/**
 * Teacher Attendance view - mark attendance with calendar view.
 */
'use strict';

const TeacherAttendance = {
  rows: [],
  teacherId: '',
  dateFrom: '',
  dateTo: '',
  currentDate: new Date().toISOString().split('T')[0],
  selectedDate: new Date(),
  _eventRegistry: new WeakMap(),

  async load() {
    const view = $('#view-teacher-attendance');
    view.innerHTML = '<div class="empty"><span class="spinner"></span> Loading...</div>';

    // Fetch fresh data
    const [teachers, attendanceRecords] = await Promise.all([
      window.api.teachers.list(),
      window.api.teacherAttendance.list({
        teacherId: this.teacherId ? Number(this.teacherId) : undefined,
        dateFrom: this.dateFrom,
        dateTo: this.dateTo,
      }),
    ]);

    this.teachers = teachers;
    this.currentDate = this.dateFrom || new Date().toISOString().split('T')[0];

    // Show ALL teachers for the current date with attendance status
    this.rows = [];
    for (const teacher of teachers) {
      const existing = attendanceRecords.find(r => r.teacherId === teacher.id && r.date === this.currentDate);
      if (existing) {
        this.rows.push(existing);
      } else {
        // Create placeholder row
        this.rows.push({
          id: null,
          teacherId: teacher.id,
          date: this.currentDate,
          status: null,
          note: '',
          teacherName: teacher.fullName,
          teacherCode: teacher.employeeCode || '—',
        });
      }
    }
    this.rows.sort((a, b) => (a.teacherName || '').localeCompare(b.teacherName || ''));

    this.allRows = [...this.rows];

    // Filter out placeholder rows (null id) for summary calculations
    const realRows = this.rows.filter(r => r.id !== null);

    view.innerHTML = `
      <div class="attendance-container">
        <div class="attendance-main">
          <div class="card">
            <div class="card-head">
              <h3>Teacher Attendance <span class="muted small">(${this.currentDate})</span></h3>
              <div class="search-row no-print">
                <button class="btn primary" id="tt_saveAll">Save All</button>
              </div>
            </div>
            <div class="card-body tight">
              ${this.rows.length > 0 ? `
                <div class="attendance-table-wrap">
                  <table class="attendance-table">
                    <thead>
                      <tr>
                        <th style="width: 120px">Teacher Code</th>
                        <th>Name</th>
                        <th style="width: 120px">Present</th>
                        <th style="width: 120px">Absent</th>
                        <th style="width: 120px">Leave</th>
                        <th style="width: 100px">Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${this.rows.map((r) => this.row(r)).join('')}
                    </tbody>
                  </table>
                </div>
              ` : `<div class="empty"><div class="big">📅</div>No teachers to mark attendance</div>`}
            </div>
          </div>
        </div>
        <div class="attendance-sidebar">
          ${this.renderCalendar()}
          <div class="attendance-stats">
            <div class="stat-item stat-present">
              <div class="stat-label">Present</div>
              <div class="stat-value">${realRows.filter(r => r.status === 'Present').length}</div>
            </div>
            <div class="stat-item stat-absent">
              <div class="stat-label">Absent</div>
              <div class="stat-value">${realRows.filter(r => r.status === 'Absent').length}</div>
            </div>
            <div class="stat-item stat-leave">
              <div class="stat-label">Leave</div>
              <div class="stat-value">${realRows.filter(r => r.status === 'Leave').length}</div>
            </div>
          </div>
        </div>
      </div>`;

    this.bind(view);
    this.bindKeys();
  },

  bindKeys() {
    Keys.register('teacher-attendance', {
      s: { keys: 'S', label: 'Save all', run: () => $('#tt_saveAll')?.click() },
    });
  },

  renderCalendar() {
    const now = this.selectedDate;
    const year = now.getFullYear();
    const month = now.getMonth();
    const monthName = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startDay = firstDay.getDay();
    const daysInMonth = lastDay.getDate();
    
    const today = new Date();
    const currentDateStr = this.currentDate;
    
    let calendarHTML = `
      <div class="calendar-widget">
        <div class="calendar-header">
          <button class="calendar-nav" data-nav="prev">‹</button>
          <div class="calendar-month">${monthName}</div>
          <button class="calendar-nav" data-nav="next">›</button>
        </div>
        <div class="calendar-grid">
          <div class="calendar-day-name">Sun</div>
          <div class="calendar-day-name">Mon</div>
          <div class="calendar-day-name">Tue</div>
          <div class="calendar-day-name">Wed</div>
          <div class="calendar-day-name">Thu</div>
          <div class="calendar-day-name">Fri</div>
          <div class="calendar-day-name">Sat</div>`;
    
    for (let i = 0; i < startDay; i++) {
      calendarHTML += '<div class="calendar-day calendar-day-empty"></div>';
    }
    
    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(year, month, day);
      // Format date in local timezone to avoid UTC offset issues
      const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      const isToday = dateStr === todayStr;
      const isSelected = dateStr === currentDateStr;
      
      let classes = 'calendar-day';
      if (isToday) classes += ' calendar-day-today';
      if (isSelected) classes += ' calendar-day-selected';
      
      calendarHTML += `<div class="${classes}" data-date="${dateStr}">${day}</div>`;
    }
    calendarHTML += `
        </div>
      </div>`;
    
    return calendarHTML;
  },

  row(r) {
    const teacher = this.teachers.find((t) => t.id === r.teacherId) || {};
    const teacherName = r.teacherName || teacher.fullName || 'Unknown';
    const teacherCode = r.teacherCode || teacher.employeeCode || '—';
    const status = r.status;
    
    return `
      <tr data-teacher-id="${r.teacherId}">
        <td class="mono">${esc(teacherCode)}</td>
        <td><strong>${esc(teacherName)}</strong></td>
        <td>
          <label class="radio-btn ${status === 'Present' ? 'active' : ''}">
            <input type="radio" name="status_${r.teacherId}" value="Present" ${status === 'Present' ? 'checked' : ''}>
            <span class="radio-custom"></span>
          </label>
        </td>
        <td>
          <label class="radio-btn ${status === 'Absent' ? 'active' : ''}">
            <input type="radio" name="status_${r.teacherId}" value="Absent" ${status === 'Absent' ? 'checked' : ''}>
            <span class="radio-custom"></span>
          </label>
        </td>
        <td>
          <label class="radio-btn ${status === 'Leave' ? 'active' : ''}">
            <input type="radio" name="status_${r.teacherId}" value="Leave" ${status === 'Leave' ? 'checked' : ''}>
            <span class="radio-custom"></span>
          </label>
        </td>
        <td>
          <button class="btn-note" data-teacher-id="${r.teacherId}" title="${r.note || 'Add note'}">Note</button>
        </td>
      </tr>`;
  },

  bind(view) {
    const reg = this._eventRegistry;
    
    delegateOnce(reg, view, 'click', '.calendar-nav', (e, btn) => {
      const direction = btn.dataset.nav;
      const current = this.selectedDate;
      if (direction === 'prev') {
        this.selectedDate = new Date(current.getFullYear(), current.getMonth() - 1, 1);
      } else {
        this.selectedDate = new Date(current.getFullYear(), current.getMonth() + 1, 1);
      }
      this.load();
    });
    
    delegateOnce(reg, view, 'click', '.calendar-day:not(.calendar-day-empty)', (e, day) => {
      const selectedDate = day.dataset.date;
      if (selectedDate) {
        this.currentDate = selectedDate;
        this.dateFrom = selectedDate;
        this.dateTo = '';
        this.load();
      }
    });
    
    delegateOnce(reg, view, 'change', '.radio-btn input', async (e, input) => {
      const row = input.closest('tr');
      const teacherId = Number(row.dataset.teacherId);
      const status = input.value;
      
      const allRadios = row.querySelectorAll('.radio-btn');
      allRadios.forEach(rb => rb.classList.remove('active'));
      input.closest('.radio-btn').classList.add('active');
      
      await this.toggleAttendance(teacherId, status);
    });
    
    delegateOnce(reg, view, 'click', '.btn-note', async (e, btn) => {
      const teacherId = Number(btn.dataset.teacherId);
      const row = this.rows.find(r => r.teacherId === teacherId);
      const currentNote = row?.note || '';
      
      const note = prompt('Enter note for teacher:', currentNote);
      if (note !== null) {
        try {
          await window.api.teacherAttendance.upsert({
            teacherId,
            date: this.currentDate,
            status: row?.status || null,
            note: note
          });
          
          this.rows = this.rows.map((item) =>
            item.teacherId === teacherId ? { ...item, note } : item
          );
          
          btn.title = note || 'Add note';
          notify.ok('Note saved', 'Teacher note updated');
        } catch (err) {
          notify.error('Failed', err.message);
        }
      }
    });
    
    delegateOnce(reg, view, 'click', '#tt_saveAll', async (e, btn) => {
      if (btn.disabled) return;
      await this.saveAllForDate();
    });
  },

  async toggleAttendance(teacherId, status) {
    try {
      const date = this.currentDate;
      await window.api.teacherAttendance.upsert({ teacherId, date, status });

      this.rows = this.rows.map((item) =>
        item.teacherId === teacherId ? { ...item, status, id: item.id || -1 } : item
      );

      this.updateSummary();
    } catch (err) {
      notify.error('Failed', err.message);
    }
  },
  
  updateSummary() {
    const present = this.rows.filter((r) => r.status === 'Present').length;
    const absent = this.rows.filter((r) => r.status === 'Absent').length;
    const leave = this.rows.filter((r) => r.status === 'Leave').length;

    const presentEl = document.querySelector('.stat-present .stat-value');
    const absentEl = document.querySelector('.stat-absent .stat-value');
    const leaveEl = document.querySelector('.stat-leave .stat-value');
    
    if (presentEl) presentEl.textContent = present;
    if (absentEl) absentEl.textContent = absent;
    if (leaveEl) leaveEl.textContent = leave;
  },

  async saveAllForDate() {
    const date = this.currentDate;
    const updates = this.rows
      .filter(r => r.status)
      .map(r => ({ teacherId: r.teacherId, date, status: r.status, note: r.note || '' }));
    
    for (const update of updates) {
      await window.api.teacherAttendance.upsert(update);
    }
    
    notify.ok('Saved', 'All teacher attendance saved');
    await this.load();
  },

  async openMarkModal() {
    const teachers = await window.api.teachers.list();
    if (!teachers.length) {
      notify.warn('No teachers', 'Please add teachers first.');
      return;
    }

    await openModal((close) =>
      el('div', { class: 'modal' }, [
        el('div', { class: 'modal-head' }, [
          el('h3', { text: 'Mark Attendance' }),
          el('button', { class: 'btn ghost sm', text: 'Close', onClick: close }),
        ]),
        el('div', { class: 'modal-body' }, [
          el('div', { class: 'form-grid' }, [
            el('div', { class: 'field full' }, [
              el('label', { for: 'mark_tt_teacher', text: 'Teacher' }),
              el('select', { id: 'mark_tt_teacher' },
                teachers.map((t) => el('option', { value: t.id, text: t.fullName }))
              ),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'mark_tt_date', text: 'Date' }),
              el('input', { id: 'mark_tt_date', type: 'date', value: new Date().toISOString().split('T')[0] }),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: 'mark_tt_status', text: 'Status' }),
              el('select', { id: 'mark_tt_status' }, [
                el('option', { value: 'Present', text: 'Present' }),
                el('option', { value: 'Late', text: 'Late' }),
                el('option', { value: 'Absent', text: 'Absent' }),
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
  },

  async save(close) {
    const teacherId = Number($('#mark_tt_teacher').value);
    const date = $('#mark_tt_date').value.trim();
    const status = $('#mark_tt_status').value;

    if (!teacherId || !date) {
      notify.warn('Missing fields', 'Please select a teacher and date.');
      return;
    }

    try {
      await window.api.teacherAttendance.upsert({ teacherId, date, status });
      notify.ok('Attendance saved', `${date}: ${status}`);
      close();
      await this.load();
    } catch (err) {
      notify.error('Failed', err.message);
    }
  },

  async saveAllForDate() {
    if (!this.currentDate) {
      notify.warn('No date', 'Select a date first.');
      return;
    }
    const date = this.currentDate;
    const rows = Array.from(document.querySelectorAll('#view-teacher-attendance tbody tr'));
    let saved = 0;
    let failed = 0;
    for (const row of rows) {
      const teacherId = Number(row.dataset.teacherId);
      const presentBtn = row.querySelector('.att-btn[data-status="Present"]');
      if (!presentBtn) continue;
      const status = presentBtn.classList.contains('active') ? 'Present' : 'Absent';
      try {
        await window.api.teacherAttendance.upsert({ teacherId, date, status });
        saved++;
      } catch {
        failed++;
      }
    }
    if (failed > 0) {
      notify.warn('Partial save', `${saved} saved, ${failed} failed.`);
    } else {
      notify.ok('Attendance saved', `${saved} teachers marked for ${date}`);
    }
    await this.load();
  },
};
