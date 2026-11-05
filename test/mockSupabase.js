/**
 * A minimal fake of Supabase's REST API (PostgREST) serving one "staff" table, for tests and the demo.
 * It checks the key, the table name and the requested columns, and supports order/limit/offset.
 */
import express from 'express';

export const MOCK_SUPABASE_KEY = 'mock-supabase-service-key';

export function sampleHubRows() {
  return [
    // Matches TASK clerk 201 by email; mobile and payroll ID differ
    { id: 'h-1', first_name: 'Sam', last_name: 'Manager', email: 'manager@madmex.example', is_active: true, mobile: '0400 000 999', payroll_id: 'P001', venue_no: 1, tax_file_number: '123 456 789' },
    // TASK clerk 202 has no email: matched by name (needs approval)
    { id: 'h-2', first_name: 'Alex', last_name: 'Crew', email: 'alex.crew@madmex.example', is_active: true, mobile: '', payroll_id: 'P002', venue_no: 1, tax_file_number: '223 456 789' },
    // Left the business: deactivate TASK clerk 203
    { id: 'h-3', first_name: 'Jordan', last_name: 'Lee', email: 'jordan.lee@madmex.example', is_active: false, mobile: '', payroll_id: '', venue_no: 1, tax_file_number: '' },
    // Two TASK clerks called Chris Smith: needs a person to decide
    { id: 'h-4', first_name: 'Chris', last_name: 'Smith', email: 'chris.smith@madmex.example', is_active: true, mobile: '', payroll_id: '', venue_no: 1, tax_file_number: '' },
    // New starter: created in TASK
    { id: 'h-5', first_name: 'Morgan', last_name: 'New', email: 'morgan.new@madmex.example', is_active: true, mobile: '0400 000 555', payroll_id: 'P005', venue_no: 2, tax_file_number: '523 456 789' },
    // Back from leave: reactivate TASK clerk 207
    { id: 'h-6', first_name: 'Riley', last_name: 'Receiver', email: 'riley@madmex.example', is_active: 'active', mobile: '', payroll_id: '', venue_no: 1, tax_file_number: '' },
    // Inactive and not in TASK: nothing to do
    { id: 'h-7', first_name: 'Casey', last_name: 'Gone', email: 'casey@madmex.example', is_active: false, mobile: '', payroll_id: '', venue_no: 1, tax_file_number: '' },
    // A TASK administrator marked inactive: reported, not deactivated
    { id: 'h-8', first_name: 'Pat', last_name: 'Boss', email: 'pat.boss@madmex.example', is_active: false, mobile: '', payroll_id: '', venue_no: 1, tax_file_number: '' },
    // Missing email: can't be created
    { id: 'h-9', first_name: 'Dana', last_name: 'Noemail', email: '', is_active: true, mobile: '', payroll_id: '', venue_no: 1, tax_file_number: '' },
  ];
}

export function createMockSupabase({ key = MOCK_SUPABASE_KEY, table = 'staff', rows = sampleHubRows() } = {}) {
  const state = { key, table, rows, requests: [], failStatus: null };
  const app = express();

  app.get('/rest/v1/:table', (req, res) => {
    state.requests.push({
      table: req.params.table,
      query: { ...req.query },
      apikey: req.get('apikey'),
      authorization: req.get('authorization'),
      profile: req.get('accept-profile'),
    });
    if (state.failStatus) return res.status(state.failStatus).json({ message: 'Service unavailable' });
    if (req.get('apikey') !== state.key || req.get('authorization') !== `Bearer ${state.key}`) {
      return res.status(401).json({ message: 'Invalid API key' });
    }
    if (req.params.table !== state.table) {
      return res.status(404).json({ message: `relation "public.${req.params.table}" does not exist` });
    }
    const known = new Set(Object.keys(sampleHubRows()[0]));
    const select = String(req.query.select || '*').split(',');
    const missing = select.find((c) => c !== '*' && !known.has(c));
    if (missing) return res.status(400).json({ message: `column ${state.table}.${missing} does not exist` });
    let out = [...state.rows];
    const [orderCol] = String(req.query.order || '').split('.');
    if (orderCol) out.sort((a, b) => String(a[orderCol]).localeCompare(String(b[orderCol])));
    const offset = Number(req.query.offset) || 0;
    const limit = req.query.limit ? Number(req.query.limit) : out.length;
    out = out.slice(offset, offset + limit);
    res.json(select.includes('*') ? out : out.map((r) => Object.fromEntries(select.map((c) => [c, r[c]]))));
  });

  return { app, state };
}
