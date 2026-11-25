# Try the system yourself: demo guide

Everything here uses **fictional data** and **development secrets**. It is a prototype: it shows how the system flows, and it is not approved or secured for real use.

## 1. Start it

Double-click **`start-demo.bat`** in the project folder, or run `pnpm demo`.

* The first start takes a few minutes (it builds the apps, creates the database and loads the demo data). Later starts take about 30 seconds.
* When it prints **"KIU-USCAS demo is running"**, the admin console opens in your browser.
* Your data is kept in `.demo-data`. Delete that folder for a completely fresh start. **Ctrl+C** stops everything.
* All logins, activation codes and reader setup values are written to **`.demo-data/CREDENTIALS.md`**.

| App | Address | Who it is for |
|---|---|---|
| Admin console | http://localhost:3000 | staff |
| Student wallet | http://localhost:3001 | students (phone-sized) |
| Reader | http://localhost:3002 | the person at a door or desk |
| API documentation | http://localhost:4000/api/docs | developers |

Tip: open the three apps in **separate browser windows** side by side (or use a private window for the student). They keep separate sessions.

## 2. The idea in one minute

One student identity, one set of rules, many ways to prove who you are:

```
 Student card (virtual QR)  ─┐
 Card tap (simulated)        ├─►  who is this student?  ─►  rules engine  ─►  GRANT / DENY + reason  ─►  audit trail
 Optional face (prototype)  ─┘      (never trusts the client)   (fees, registration, fines, time, place…)
```

Every refusal has a specific reason and tells the student which office to visit.

## 3. A first walkthrough (about 10 minutes)

### A. Look around as the administrator
1. Open http://localhost:3000 and sign in as `demo-admin@kiu-demo.test` / `Demo-Password-2026!`.
2. **Overview**: live counters and a chart. Keep this window visible; it updates by itself when something happens at a reader.
3. Click through the menu: Students, Cards, Readers, Rules, Finance, Library, Hostels, Meal sittings, Timetable, Examinations, Reports, Data imports, Settings, Face verification, Overrides, Access logs, Alerts, Audit trail, Users.

### B. Be a student: activate your card and get a QR code
1. Open http://localhost:3001 (a private window is handy) and sign in as `student01@kiu-demo.test`.
2. Open **My card**, type the **activation code** for student01 from `.demo-data/CREDENTIALS.md`, and activate.
3. A **QR code that changes every 30 seconds** appears. Below it, a text version of the code can be copied.
4. **My access** shows which services you can use right now, and why not for the others.

### C. Be the door: scan the card at a reader
1. Open http://localhost:3002. On the setup screen enter the server address and one reader's ID, Key ID and Secret from `CREDENTIALS.md` (start with the **Main gate**).
2. In the student wallet, copy the code text; at the reader paste it into the **"enter the code"** box and press verify. (A phone camera pointed at the QR code works too.)
3. You see **GRANT** or **DENY** with the reason, the student's name, and how long the decision took.
4. Watch the admin **Overview** and **Access logs** update.
5. Try the **same code again**: it is refused, because each QR code works once.

### D. See a refusal and fix it
1. Reader: **Exam hall A** (service EXAM). Scan student01 again. A refusal such as *not cleared for examinations* appears with the office to contact (Finance).
2. Console, as the Finance officer (`finance-officer@kiu-demo.test`) or as the administrator: **Finance**, find the student, set fees paid to 100% and tick cleared, give a reason.
3. Scan again: the very next scan is granted. The change is in the **Audit trail** with before and after values, and the student got a notification.

### E. More things to try
| Area | What to do |
|---|---|
| **Library** | Library page: add a loan, mark it overdue or return it; scan at the *Library borrowing desk* reader and watch the result change. |
| **Cafeteria** | Scan twice at the *Cafeteria* reader: the second scan is refused (one meal per sitting). |
| **Hostel** | Hostels: allocate a student to a room, then scan at *Hostel A door*. |
| **Exams** | Examinations: schedule a paper, seat the students (Seats), and view attendance after scanning at the exam hall reader. |
| **Overrides** | After a rule-based refusal, Overrides lets a trusted person admit the student with a written reason. Lost cards and suspended accounts can never be overridden. |
| **Reports** | Reports: pick dates, see totals, download the CSV (it is audited). |
| **Imports** | Data imports: paste CSV text for Finance, Registry or Library, preview what would change, then apply. |
| **Settings** | Change the placeholder policy values (fine limit, minimum fees %), venues and the academic calendar. |
| **Lost card** | In the wallet, Account → Report my card lost. The next scan with it is refused and raises a high-priority alert. |
| **Users and roles** | Sign in as different staff roles (see `CREDENTIALS.md`) to see how each role only gets the pages it needs. |

### F. Face verification (prototype)
Face enrolment is **compulsory by policy** (with exemptions), and the engine is clearly labelled **PROTOTYPE**: it compares tiny brightness patterns, it is **not real face recognition**, and it is not accurate or spoof-proof. It exists to show the flow: consent, enrolment, instant feedback, deletion.

1. Admin console → **Face verification**. Read the notice, enter a registration number (for example `2026-BCS-0001`), tick that the notice was explained to the student, allow the camera, and press **Capture and enrol**.
2. Reader app (connected to the **Main gate**, which is face-capable) → **SCAN FACE** → enter the same registration number → **Verify face**. You get an instant answer with the time it took.
3. Have someone else (or a very different pose and lighting) try the same registration number: it is refused with *face did not match*.
4. In the student wallet, Account → **My face** → **Delete my face data**. The reader now refuses face for that student. The card and QR code still work until an enforcement date is set.
5. Compulsory enrolment: in **Face verification**, the card **Who still has to enrol** lists every student without a face or an exemption. Use **Exempt** (needs a 10+ character reason) for someone who cannot or must not use it, and the wallet shows them as exempt. Under **Policy**, set **Enforce from** to today and the card/QR of every student who is neither enrolled nor exempt is refused (`FACE_ENROLMENT_REQUIRED`) until they enrol. Clear the date to undo it.

## 4. Things that are deliberately not finished

* Real face recognition (needs an approved vendor SDK and a privacy review). More report types, PDF export and Excel import. Load and speed testing. Tap-to-pay style AES tap in the browser (the simulator command line does it).
* The values for fees, fines, meal times and so on are **placeholders** until the university confirms its real policy; change them in Settings.

## 5. Troubleshooting

| Problem | Fix |
|---|---|
| "Port … is already in use" | Close the earlier demo or dev server and start again. |
| Browser shows the login page after a restart | Sign in again; sessions are not kept across restarts of the API. |
| The reader says the credentials are refused | Copy the reader ID, key ID and secret from `.demo-data/CREDENTIALS.md` without spaces; the secret is shown only there. |
| Camera does not start | Allow the camera in the browser address bar. `localhost` is allowed to use it; other addresses need HTTPS. |
| Start over from scratch | Stop the demo, delete the `.demo-data` folder, start again. |
