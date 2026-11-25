import { Banner, Button, Card, DataTable, FaceCapture, Field, Pager, Skeleton, StatusChip, type FaceCaptureHandle, type FaceState } from '@kiu/ui';
import { useRef, useState } from 'react';
import { api } from '../lib/api';
import { can, type Me } from '../lib/auth';
import { fmt, qs, useApi, type Paged } from '../lib/hooks';
import { PageHeader, ReasonModal, errText } from '../components/Common';

interface Notice { version: string; required: boolean; title: string; points: string[]; prototypeOnly: boolean; engine: string }
interface Enrolment { id: string; status: string; enrolledAt: string | null; lastVerifiedAt: string | null; regNo: string; fullName: string; model: { name: string; version: string; isMock: boolean } | null }
interface Policy { MATCH_THRESHOLD: number; FACE_ENABLED: boolean; ENROLMENT_REQUIRED: boolean; ENFORCE_FROM: string | null; prototypeOnly: boolean; engine: string }
interface Pending { summary: { required: boolean; enforceFrom: string | null; enforced: boolean; students: number; enrolled: number; exempt: number; pending: number }; data: { regNo: string; fullName: string; programme: string }[]; meta: Paged<unknown>['meta'] }
interface Device { id: string; code: string; name: string; status: string; authorised: boolean }

const TONE: Record<string, 'grant' | 'warn' | 'deny' | 'info'> = { ACTIVE: 'grant', SUSPENDED: 'warn', REVOKED: 'deny', DELETED: 'info', PENDING: 'info' };

export function Biometrics({ me }: { me: Me }) {
  const enrolAllowed = can(me, 'biometrics.enroll');
  const revokeAllowed = can(me, 'biometrics.revoke');
  const policyAllowed = can(me, 'biometrics.policy.manage');
  const [page, setPage] = useState(1);
  const list = useApi<Paged<Enrolment>>(`/biometrics/enrollments${qs({ page, pageSize: 8 })}`);
  const notice = useApi<Notice>(enrolAllowed ? '/biometrics/notice' : null);
  const policy = useApi<Policy>('/biometrics/policy');
  const [pPage, setPPage] = useState(1);
  const pending = useApi<Pending>(`/biometrics/pending${qs({ page: pPage, pageSize: 6 })}`);
  const [exempting, setExempting] = useState<{ regNo: string; fullName: string } | null>(null);
  const [enforceDate, setEnforceDate] = useState('');
  const devices = useApi<Device[]>('/biometrics/devices');

  const cam = useRef<FaceCaptureHandle>(null);
  const [regNo, setRegNo] = useState('');
  const [consent, setConsent] = useState(false);
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<FaceState>('idle');
  const [caption, setCaption] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<Enrolment | null>(null);
  const [threshold, setThreshold] = useState<string>('');
  const [policyBusy, setPolicyBusy] = useState(false);
  const [policyReason, setPolicyReason] = useState('');

  const enrol = async () => {
    setBusy(true); setErr(null); setState('checking'); setCaption(undefined);
    const t0 = performance.now();
    try {
      const frames = await cam.current?.capture();
      if (!frames) throw new Error('The camera is not ready yet.');
      await api('POST', '/biometrics/enrollments', { regNo: regNo.trim(), noticeVersion: notice.data!.version, consentConfirmed: consent, frames });
      setState('ok'); setCaption(`Enrolled · ${Math.round(performance.now() - t0)} ms`);
      setRegNo(''); setConsent(false); list.reload();
    } catch (x) { setState('fail'); setCaption(errText(x)); setErr(errText(x)); } finally { setBusy(false); window.setTimeout(() => setState('idle'), 3500); }
  };

  const savePolicy = async (patch: { matchThreshold?: number; faceEnabled?: boolean; enrolmentRequired?: boolean; enforceFrom?: string | null }) => {
    setPolicyBusy(true); setErr(null);
    try { await api('PUT', '/biometrics/policy', { ...patch, reason: policyReason.trim() }); setPolicyReason(''); setThreshold(''); setEnforceDate(''); policy.reload(); pending.reload(); } catch (x) { setErr(errText(x)); } finally { setPolicyBusy(false); }
  };
  const setDevice = async (d: Device, authorised: boolean) => {
    setErr(null);
    try { await api('PUT', `/biometrics/devices/${d.id}`, { authorised, reason: `${authorised ? 'Authorised' : 'Revoked'} from the console` }); devices.reload(); } catch (x) { setErr(errText(x)); }
  };

  return (
    <div className="kiu-stack">
      <PageHeader title="Face verification" />
      <Banner tone="warn">
        Prototype engine ({policy.data?.engine ?? 'prototype-luminance-mock'}). It compares tiny luminance thumbnails to demonstrate enrolment, matching and deletion. It has <strong>no accuracy or anti-spoofing evidence</strong> and must not be used to protect anything real. {policy.data?.ENROLMENT_REQUIRED === false ? 'Enrolment is currently voluntary: the card and QR code always work without it.' : 'Enrolment is compulsory for every student; students who cannot or must not enrol are given an exemption and keep using their card and QR code.'}
      </Banner>
      {err && <Banner tone="deny">{err}</Banner>}

      {enrolAllowed && (
        <Card className="kiu-stack">
          <h2>Enrol a student</h2>
          {notice.data && (
            <div className="kiu-stack" data-testid="face-notice">
              <strong>{notice.data.title}</strong>
              <ul style={{ margin: 0, paddingLeft: 20 }}>{notice.data.points.map((p) => <li key={p}>{p}</li>)}</ul>
              <span className="muted mono">Notice version {notice.data.version}</span>
            </div>
          )}
          <div className="kiu-grid cols-2">
            <FaceCapture ref={cam} state={state} caption={caption} prototypeLabel="PROTOTYPE" onReady={setReady} />
            <div className="kiu-stack">
              <Field id="bio-reg" label="Registration number" value={regNo} onChange={(e) => setRegNo(e.target.value)} autoComplete="off" placeholder="2026-BCS-0001" />
              <label className="kiu-row" style={{ alignItems: "flex-start", minHeight: 44 }}>
                <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} data-testid="face-consent" style={{ width: 24, height: 24, marginTop: 2 }} />
                <span>{notice.data?.required === false ? 'The student has read the notice above, in person, and freely agrees to optional face verification.' : 'The notice above has been shown and explained to the student in person, including the right to ask for an exemption.'}</span>
              </label>
              <Button onClick={enrol} disabled={busy || !ready || !consent || !regNo.trim() || !notice.data} data-testid="face-enrol">{busy ? 'Capturing…' : 'Capture and enrol'}</Button>
            </div>
          </div>
        </Card>
      )}

      {pending.data && (
        <Card className="kiu-stack" data-testid="face-pending">
          <h2>Who still has to enrol</h2>
          <div className="kiu-row" style={{ flexWrap: 'wrap', gap: 16 }} data-testid="face-pending-summary">
            <span><strong>{pending.data.summary.enrolled}</strong> <span className="muted">enrolled</span></span>
            <span><strong>{pending.data.summary.exempt}</strong> <span className="muted">exempt</span></span>
            <span><strong>{pending.data.summary.pending}</strong> <span className="muted">still to enrol</span></span>
            <span className="muted">of {pending.data.summary.students} active students</span>
            <StatusChip tone={pending.data.summary.enforced ? 'deny' : pending.data.summary.required ? 'warn' : 'info'}>
              {!pending.data.summary.required ? 'Not compulsory' : pending.data.summary.enforced ? `Enforced since ${pending.data.summary.enforceFrom}` : pending.data.summary.enforceFrom ? `Enforced from ${pending.data.summary.enforceFrom}` : 'Compulsory, no deadline set'}
            </StatusChip>
          </div>
          {pending.data.summary.enforced && <Banner tone="warn">Students below are being refused at every reader until they enrol or are exempted.</Banner>}
          <DataTable testId="face-pending-list" rows={pending.data.data.map((r) => ({ ...r, id: r.regNo }))} empty="Everyone has enrolled or has an exemption." columns={[
            { key: 'reg', header: 'Reg. no.', render: (r) => <span className="mono">{r.regNo}</span> },
            { key: 'name', header: 'Student', render: (r) => r.fullName },
            { key: 'prog', header: 'Programme', render: (r) => r.programme },
            { key: 'a', header: 'Actions', render: (r) => (
              <div className="kiu-row">
                {enrolAllowed && <Button variant="secondary" onClick={() => { setRegNo(r.regNo); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Enrol now</Button>}
                {policyAllowed && <Button variant="secondary" onClick={() => setExempting(r)} data-testid={`face-exempt-${r.regNo}`}>Exempt</Button>}
              </div>
            ) },
          ]} />
          <Pager page={pending.data.meta.page} totalPages={pending.data.meta.totalPages} total={pending.data.meta.total} onPage={setPPage} />
        </Card>
      )}

      <Card>
        <h2>Enrolments</h2>
        {list.error && <Banner tone="deny">{list.error}</Banner>}
        {list.loading && !list.data ? <Skeleton h={120} /> : (
          <>
            <DataTable testId="face-enrolments" rows={list.data?.data ?? []} empty="Nobody has enrolled for face verification." columns={[
              { key: 'reg', header: 'Reg. no.', render: (r) => <span className="mono">{r.regNo}</span> },
              { key: 'name', header: 'Student', render: (r) => r.fullName },
              { key: 'status', header: 'Status', render: (r) => <StatusChip tone={TONE[r.status] ?? 'info'}>{r.status}</StatusChip> },
              { key: 'model', header: 'Engine', render: (r) => r.model ? `${r.model.name}${r.model.isMock ? ' (mock)' : ''}` : '—' },
              { key: 'seen', header: 'Last verified', render: (r) => r.lastVerifiedAt ? fmt(r.lastVerifiedAt) : 'Never' },
              { key: 'a', header: 'Actions', render: (r) => revokeAllowed && r.status === 'ACTIVE' ? <Button variant="secondary" onClick={() => setRevoking(r)} data-testid={`face-revoke-${r.regNo}`}>Revoke</Button> : null },
            ]} />
            {list.data && <Pager page={list.data.meta.page} totalPages={list.data.meta.totalPages} total={list.data.meta.total} onPage={setPage} />}
          </>
        )}
      </Card>

      <div className="kiu-grid cols-2">
        <Card className="kiu-stack">
          <h2>Policy</h2>
          {policy.data ? (
            <>
              <dl style={{ margin: 0 }}>
                <dt className="muted">Face verification</dt><dd><StatusChip tone={policy.data.FACE_ENABLED ? 'grant' : 'warn'}>{policy.data.FACE_ENABLED ? 'Enabled' : 'Switched off'}</StatusChip></dd>
                <dt className="muted">Enrolment</dt><dd><StatusChip tone={policy.data.ENROLMENT_REQUIRED ? 'warn' : 'info'}>{policy.data.ENROLMENT_REQUIRED ? 'Compulsory' : 'Voluntary'}</StatusChip> {policy.data.ENROLMENT_REQUIRED && <span className="muted" data-testid="face-enforce-from">{policy.data.ENFORCE_FROM ? `refused at readers from ${policy.data.ENFORCE_FROM}` : 'no enforcement date yet'}</span>}</dd>
                <dt className="muted">Match threshold (cosine)</dt><dd className="mono" data-testid="face-threshold">{policy.data.MATCH_THRESHOLD}</dd>
                <dt className="muted">Search mode</dt><dd>1:1 only (1:N is disabled)</dd>
              </dl>
              {policyAllowed && (
                <div className="kiu-stack">
                  <Field id="pol-reason" label="Reason (audited)" value={policyReason} onChange={(e) => setPolicyReason(e.target.value)} />
                  <div className="kiu-row" style={{ alignItems: 'flex-end' }}>
                    <div style={{ flex: '1 1 120px' }}><Field id="pol-thr" label="New threshold (0.50–0.99)" value={threshold} onChange={(e) => setThreshold(e.target.value)} inputMode="decimal" /></div>
                    <Button variant="secondary" disabled={policyBusy || policyReason.trim().length < 5 || !(Number(threshold) >= 0.5 && Number(threshold) <= 0.99)} onClick={() => void savePolicy({ matchThreshold: Number(threshold) })}>Set threshold</Button>
                  </div>
                  <div className="kiu-row" style={{ alignItems: 'flex-end' }}>
                    <div className="kiu-field" style={{ flex: '1 1 170px' }}><label htmlFor="pol-date">Enforce from (date)</label><input id="pol-date" className="kiu-input" type="date" value={enforceDate} onChange={(e) => setEnforceDate(e.target.value)} /></div>
                    <Button variant="secondary" disabled={policyBusy || policyReason.trim().length < 5 || !enforceDate} onClick={() => void savePolicy({ enforceFrom: enforceDate })} data-testid="face-enforce-set">Set date</Button>
                    <Button variant="secondary" disabled={policyBusy || policyReason.trim().length < 5 || !policy.data.ENFORCE_FROM} onClick={() => void savePolicy({ enforceFrom: null })}>Clear date</Button>
                  </div>
                  <Button variant="secondary" disabled={policyBusy || policyReason.trim().length < 5} onClick={() => void savePolicy({ enrolmentRequired: !policy.data!.ENROLMENT_REQUIRED })} data-testid="face-required-toggle">{policy.data.ENROLMENT_REQUIRED ? 'Make enrolment voluntary' : 'Make enrolment compulsory'}</Button>
                  <Button variant="secondary" disabled={policyBusy || policyReason.trim().length < 5} onClick={() => void savePolicy({ faceEnabled: !policy.data!.FACE_ENABLED })} data-testid="face-toggle">{policy.data.FACE_ENABLED ? 'Switch face verification off' : 'Switch face verification on'}</Button>
                </div>
              )}
            </>
          ) : <Skeleton h={80} />}
        </Card>
        <Card className="kiu-stack">
          <h2>Face-capable readers</h2>
          <DataTable testId="face-devices" rows={devices.data ?? []} empty="No reader is registered as face-capable." columns={[
            { key: 'c', header: 'Reader', render: (d) => d.name },
            { key: 'a', header: 'Authorised', render: (d) => <StatusChip tone={d.authorised ? 'grant' : 'warn'}>{d.authorised ? 'Yes' : 'No'}</StatusChip> },
            { key: 'x', header: 'Actions', render: (d) => policyAllowed ? <Button variant="secondary" onClick={() => void setDevice(d, !d.authorised)}>{d.authorised ? 'Revoke' : 'Authorise'}</Button> : null },
          ]} />
        </Card>
      </div>

      {exempting && <ReasonModal title="Grant an exemption" intro={`Excuse ${exempting.fullName} (${exempting.regNo}) from face enrolment? They keep using their card and QR code. Give the reason (disability, safety, conscientious objection…): it is audited and shown to them.`} confirmLabel="Grant exemption" minLength={10}
        onClose={() => setExempting(null)} onConfirm={async (reason) => { await api('POST', '/biometrics/exemptions', { regNo: exempting.regNo, reason }); pending.reload(); }} />}
      {revoking && <ReasonModal title="Revoke face enrolment" intro={`Delete ${revoking.fullName}'s face template? Their card and QR code are not affected.`} confirmLabel="Delete template" danger
        onClose={() => setRevoking(null)} onConfirm={async (reason) => { await api('POST', `/biometrics/enrollments/${revoking.id}/revoke`, { reason }); list.reload(); }} />}
    </div>
  );
}
