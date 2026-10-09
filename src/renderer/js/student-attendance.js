/**
 * Student Attendance view - mark attendance by class and date with calendar view.
 */
'use strict';

const StudentAttendance = {
  rows: [],
  classId: '',
  studentId: '',
  dateFrom: '',
  dateTo: '',
  currentDate: new Date().toISOString().split('T')[0],
  selectedDate: new Date(),
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

    // If a class is selected, show ALL students from that class for the current date
    if (this.classId) {
      const className = this.classes.find(c => c.id == this.classId)?.name;
      const classStudents = this.students.filter(s => s.studentClass === className);

      this.rows = [];
      for (const student of classStudents) {
        // Look in the fresh attendance records for the current date
        const existing = attendanceRecords.find(r => r.studentId === student.id && r.date === this.currentDate);
        if (existing) {
          this.rows.push(existing);
        } else {
          // Create a placeholder row for students without attendance
          this.rows.push({
            id: null,
            studentId: student.id,
            classId: this.classId,
            date: this.currentDate,
            status: null,
            note: '',
            studentName: student.name,
            rollNo: student.rollNo,
            className: className || '',
          });
        }
      }
      // Sort by student name
      this.rows.sort((a, b) => (a.studentName || '').localeCompare(b.studentName || ''));
    } else {
      // No class filter - show all attendance records
      this.rows = attendanceRecords;
    }

    this.allRows = [...this.rows];

    // Filter out placeholder rows (null id) for summary calculations
    const realRows = this.rows.filter(r => r.id !== null);

    view.innerHTML = `
      <div class="attendance-container">
        <div class="attendance-main">
          <div class="card">
            <div class="card-head">
              <h3>Student Attendance <span class="muted small">(${this.currentDate})</span></h3>
              <div class="search-row no-print">
                <select id="sa_class">
                  <option value="">Select Class</option>
                  ${this.classes.map(c => `<option value="${c.id}"${this.classId == c.id ? ' selected' : ''}>${c.name}</option>`).join('')}
                </select>
                <button class="btn primary" id="sa_saveAll">Save All</button>
              </div>
            </div>
            <div class="card-body tight">
              ${this.classId && this.rows.length > 0 ? `
                <div class="attendance-table-wrap">
                  <table class="attendance-table">
                    <thead>
                      <tr>
                        <th style="width: 100px">Student ID</th>
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
              ` : `<div class="empty"><div class="big">📅</div>Please select a class to mark attendance</div>`}
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

    const classSelect = $('#sa_class');
    if (classSelect && this.classId) classSelect.value = this.classId;

    this.bind(view);
    this.bindKeys();
  },

  bindKeys() {
    Keys.register('student-attendance', {
      s: { keys: 'S', label: 'Save all', run: () => $('#sa_saveAll')?.click() },
    });
  },

  renderCalendar() {
    const now = this.selectedDate;
    const year = now.getFullYear();
    const month = now.getMonth();
    const monthName = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startDay = firstDay.getDay(); // 0 = Sunday
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
    
    // Empty cells before the first day
    for (let i = 0; i < startDay; i++) {
      calendarHTML += '<div class="calendar-day calendar-day-empty"></div>';
    }
    
    // Days of the month
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
    const student = this.students.find((s) => s.id === r.studentId) || {};
    const studentName = r.studentName || student.name || 'Unknown';
    const rollNo = r.rollNo || student.rollNo || '—';
    const status = r.status;
    
    return `
      <tr data-student-id="${r.studentId}">
        <td class="mono">${esc(rollNo)}</td>
        <td><strong>${esc(studentName)}</strong></td>
        <td>
          <label class="radio-btn ${status === 'Present' ? 'active' : ''}">
            <input type="radio" name="status_${r.studentId}" value="Present" ${status === 'Present' ? 'checked' : ''}>
            <span class="radio-custom"></span>
          </label>
        </td>
        <td>
          <label class="radio-btn ${status === 'Absent' ? 'active' : ''}">
            <input type="radio" name="status_${r.studentId}" value="Absent" ${status === 'Absent' ? 'checked' : ''}>
            <span class="radio-custom"></span>
          </label>
        </td>
        <td>
          <label class="radio-btn ${status === 'Leave' ? 'active' : ''}">
            <input type="radio" name="status_${r.studentId}" value="Leave" ${status === 'Leave' ? 'checked' : ''}>
            <span class="radio-custom"></span>
          </label>
        </td>
        <td>
          <button class="btn-sm whatsapp-btn" data-student-id="${r.studentId}" data-status="${status}" title="Send WhatsApp alert" ${status === 'Absent' ? '' : 'disabled'}>WhatsApp</button>
          <button class="btn-note" data-student-id="${r.studentId}" title="${r.note || 'Add note'}">Note</button>
        </td>
      </tr>`;
  },

  async toggleAttendance(studentId, status) {
    try {
      const existingRow = this.rows.find((r) => r.studentId === studentId);
      const classId = existingRow?.classId || this.classId;
      const date = this.currentDate;
      
      await window.api.studentAttendance.upsert({ studentId, classId, date, status });

      // Update local state
      this.rows = this.rows.map((item) =>
        item.studentId === studentId ? { ...item, status, id: item.id || -1 } : item
      );

      // Update summary
      this.updateSummary();
    } catch (err) {
      notify.error('Failed', err.message);
    }
  },
  
  updateSummary() {
    const realRows = this.rows.filter((r) => r.id !== null && r.id !== -1);
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
  bind(view) {
    const reg = this._eventRegistry;
    
    // Class selection
    delegateOnce(reg, view, 'change', '#sa_class', async (e, sel) => {
      this.classId = sel.value;
      await this.load();
    });
    
    // Calendar navigation
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
    
    // Calendar day selection
    delegateOnce(reg, view, 'click', '.calendar-day:not(.calendar-day-empty)', (e, day) => {
      const selectedDate = day.dataset.date;
      if (selectedDate) {
        this.currentDate = selectedDate;
        this.dateFrom = selectedDate;
        this.dateTo = '';
        this.load();
      }
    });
    
    // Radio button changes
    delegateOnce(reg, view, 'change', '.radio-btn input', async (e, input) => {
      const row = input.closest('tr');
      const studentId = Number(row.dataset.studentId);
      const status = input.value;
      
      // Update radio button styles
      const allRadios = row.querySelectorAll('.radio-btn');
      allRadios.forEach(rb => rb.classList.remove('active'));
      input.closest('.radio-btn').classList.add('active');
      
      await this.toggleAttendance(studentId, status);
    });
    
    // WhatsApp button (absence alert)
    delegateOnce(reg, view, 'click', '.whatsapp-btn', async (e, btn) => {
      const studentId = Number(btn.dataset.studentId);
      const status = btn.dataset.status;
      if (status !== 'Absent') return;

      const student = this.rows.find(r => r.studentId === studentId);
      if (!student) return;

      const parent = this.students.find(s => s.id === studentId);
      if (!parent?.phone) {
        notify.warn('No phone', 'Student has no phone number in records.');
        return;
      }

      const settings = await window.api.settings.getAll();
      const schoolName = settings.whatsappSchoolName || settings.schoolName || 'School';
      const msg = `Dear Parent,\n\nAttendance notice from ${schoolName}.\nYour child ${parent.name} was marked Absent on ${this.currentDate}.\nPlease ensure they attend school tomorrow.`;

      await window.api.whatsapp.send({ phone: parent.phone, message: msg });
    });

    // Note button
    delegateOnce(reg, view, 'click', '.btn-note', async (e, btn) => {
      const studentId = Number(btn.dataset.studentId);
      const row = this.rows.find(r => r.studentId === studentId);
      const currentNote = row?.note || '';
      
      const note = prompt('Enter note for student:', currentNote);
      if (note !== null) {
        try {
          await window.api.studentAttendance.upsert({
            studentId,
            classId: this.classId,
            date: this.currentDate,
            status: row?.status || null,
            note: note
          });
          
          // Update local state
          this.rows = this.rows.map((item) =>
            item.studentId === studentId ? { ...item, note } : item
          );
          
          btn.title = note || 'Add note';
          notify.ok('Note saved', 'Student note updated');
        } catch (err) {
          notify.error('Failed', err.message);
        }
      }
    });
    
    // Save all button
    delegateOnce(reg, view, 'click', '#sa_saveAll', async (e, btn) => {
      if (btn.disabled) return;
      await this.saveAllForDate();
    });
  },

  row(r) {
    const student = this.students.find((s) => s.id === r.studentId) || {};
    const studentName = r.studentName || student.name || 'Unknown';
    const rollNo = r.rollNo || student.rollNo || '—';
    const status = r.status;
    
    return `
      <tr data-student-id="${r.studentId}">
        <td class="mono">${esc(rollNo)}</td>
        <td><strong>${esc(studentName)}</strong></td>
        <td>
          <label class="radio-btn ${status === 'Present' ? 'active' : ''}">
            <input type="radio" name="status_${r.studentId}" value="Present" ${status === 'Present' ? 'checked' : ''}>
            <span class="radio-custom"></span>
          </label>
        </td>
        <td>
          <label class="radio-btn ${status === 'Absent' ? 'active' : ''}">
            <input type="radio" name="status_${r.studentId}" value="Absent" ${status === 'Absent' ? 'checked' : ''}>
            <span class="radio-custom"></span>
          </label>
        </td>
        <td>
          <label class="radio-btn ${status === 'Leave' ? 'active' : ''}">
            <input type="radio" name="status_${r.studentId}" value="Leave" ${status === 'Leave' ? 'checked' : ''}>
            <span class="radio-custom"></span>
          </label>
        </td>
        <td>
          <button class="btn-sm whatsapp-btn" data-student-id="${r.studentId}" data-status="${status}" title="Send WhatsApp alert" ${status === 'Absent' ? '' : 'disabled'}>WhatsApp</button>
          <button class="btn-note" data-student-id="${r.studentId}" title="${r.note || 'Add note'}">Note</button>
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