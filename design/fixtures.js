'use strict';
// Stub data for the Bindery design phase. Shapes mirror what crm-web.js already
// derives (listContacts, loadRuns, taskItems, statusPage rows) so the render
// functions in screens.js can move into crm-web.js unchanged — only their data
// source swaps from these fixtures to real queries. Numbers are the real ones
// from the 2026-08-05 archive audit where known, plausible elsewhere.

const HEALTH = {
  kept: 83878, tracked: 36, rescued: 819, stranded: 0,
  lastSweep: '00:14', lastSweepAgo: '27 min', sweepStale: false,
  lastRead: 'Aug 3', lastCompact: 'Aug 3', lastTodoScan: '23:14',
  backupAge: '4 h 2 m', backupStale: false,
  hourlyToday: 24, hourlyExpected: 24,
  span: '2025-07-29 → 2026-08-05',
  signalRunning: true,
};

// contacts: {slug, name, first, rel, last, held, waiting, cursor, facts:[{t,cite}], stamp}
const CONTACTS = [
  { slug:'pine-nguyen', name:'Pine Nguyen', first:'Pine', rel:'friend · builds an AI recruiter', last:'2026-08-05', held:3063, waiting:99, cursor:91972, stamp:'99 unread',
    facts:[ {t:'Interviews every candidate himself.', cite:{a:90211,b:90219,p:90215}},
            {t:'Disappearing messages by default.', cite:{n:'34 held only here', ox:true}},
            {t:'Wants to try Opus 5 in Claude Code.', cite:{a:89514}} ] },
  { slug:'katia-jacoby', name:'Katia Jacoby', first:'Katia', rel:'close friend · Berkeley', last:'2026-08-04', held:4918, waiting:12, cursor:91717, stamp:'12 unread', stampBlue:true,
    facts:[ {t:'Bridgewater phone interview Thursday.', cite:{a:91702,b:91711}},
            {t:'Organises the weekend outings, always includes Katia’s roommate.', cite:{a:90880,b:90895}} ] },
  { slug:'charles-wu', name:'Charles Wu', first:'Charles', rel:'friend · runs the DJ bookings', last:'2026-08-04', held:2204, waiting:8, cursor:91796, stamp:'8 unread', stampBlue:true,
    facts:[ {t:'Holding $300 resale tickets through Michael, Saturday only.', cite:{a:91780,b:91796,p:91788}},
            {t:'Asked whether $685 is too low with no bar.', cite:{n:'disputed', ox:true}} ] },
  { slug:'ken-chessmore', name:'Ken Chessmore', first:'Ken', rel:'friend', last:'2026-08-04', held:1881, waiting:5, cursor:91720, stamp:'5 unread', stampBlue:true,
    facts:[ {t:'Pick him up from the subway station on the 15th.', cite:{a:91720}} ] },
  { slug:'arshia-nayebnazar', name:'Arshia Nayebnazar', first:'Arshia', rel:'friend', last:'2026-08-02', held:2660, waiting:3, cursor:91380,
    facts:[ {t:'Still owes you for the flights.', cite:{a:91380}} ] },
  { slug:'nigesh-chakraborty', name:'Nigesh Chakraborty', first:'Nigesh', rel:'friend · just moved', last:'2026-08-03', held:9477, waiting:0, cursor:90589,
    facts:[ {t:'Signed a downtown Berkeley studio, moved in 2026-08-01.', cite:{a:90544,b:90558}},
            {t:'Owes you an answer about the DJ DMs.', cite:{a:90201}} ] },
  { slug:'liang-dai', name:'Liang Dai', first:'Liang', rel:'friend · Shasta crew', last:'2026-08-01', held:2041, waiting:0, cursor:90977,
    facts:[ {t:'Planning the Shasta trip across two threads.', cite:{a:90970,b:90977}} ] },
  { slug:'ritvik-irigireddy', name:'Ritvik Irigireddy', first:'Ritvik', rel:'friend · hackathon circuit', last:'2026-07-30', held:1120, waiting:0, cursor:90938, stamp:'recovered', stampBlue:true,
    facts:[ {t:'338 older messages were stranded behind a cursor; now held.', cite:{n:'recovered 08-05', ox:true}} ] },
  { slug:'darren-pai', name:'Darren Pai', first:'Darren', rel:'friend', last:'2026-07-28', held:358, waiting:0, cursor:81628, stamp:'recovered', stampBlue:true,
    facts:[ {t:'331 older messages recovered from behind the cursor.', cite:{n:'recovered 08-05', ox:true}} ] },
  { slug:'arnav-gupta', name:'Arnav Gupta', first:'Arnav', rel:'friend · Builders', last:'2026-07-26', held:1506, waiting:0, cursor:91036,
    facts:[ {t:'Sign up for Builders and send him builders.cv.', cite:{a:91036}} ] },
  { slug:'jimmy-yu', name:'Jimmy Yu', first:'Jimmy', rel:'friend', last:'2026-07-22', held:944, waiting:0, cursor:87041, facts:[] },
  { slug:'max-wang', name:'Max Wang', first:'Max', rel:'friend', last:'2026-07-19', held:1377, waiting:0, cursor:83094, facts:[] },
  { slug:'caden-chiang', name:'Caden Chiang', first:'Caden', rel:'friend', last:'2026-07-11', held:2930, waiting:0, cursor:73300, facts:[] },
  { slug:'gavin-sontag', name:'Gavin Sontag', first:'Gavin', rel:'friend', last:'2026-07-06', held:1044, waiting:0, cursor:77816, facts:[] },
  { slug:'noah-bates', name:'Noah Bates', first:'Noah', rel:'friend', last:'2026-06-30', held:612, waiting:0, cursor:66908, facts:[] },
  { slug:'vlad-munteanu', name:'Vlad Munteanu', first:'Vlad', rel:'friend · Eastern time', last:'2026-06-16', held:3844, waiting:0, cursor:79275,
    facts:[ {t:'Dates on this card are Pacific, always.', cite:{a:79270,b:79275}} ] },
  { slug:'runqi-gao', name:'Runqi Gao', first:'Runqi', rel:'friend', last:'2026-06-12', held:489, waiting:0, cursor:18381, facts:[] },
  { slug:'sean-francis-islandhouse', name:'Sean Francis', first:'Sean', rel:'friend · island house', last:'2026-06-08', held:733, waiting:0, cursor:91815, facts:[] },
  { slug:'tiffany', name:'Tiffany', first:'Tiffany', rel:'friend', last:'2026-05-30', held:402, waiting:0, cursor:17771, facts:[] },
  { slug:'abhiram-chalamalasetty', name:'Abhiram Chalamalasetty', first:'Abhiram', rel:'friend', last:'2026-05-21', held:1275, waiting:0, cursor:62114, facts:[] },

  // ---- additional dummy people, to see the drawer at real density --------
  { slug:'priya-raman', name:'Priya Raman', first:'Priya', rel:'friend · grad school', last:'2026-08-05', held:2870, waiting:41, cursor:91940, stamp:'41 unread', stampBlue:true,
    facts:[ {t:'Defending her thesis in September; wants a mock-committee run.', cite:{a:91901,b:91940,p:91922}},
            {t:'Off coffee since July — suggest tea when you meet.', cite:{a:91410}} ] },
  { slug:'dmitri-volkov', name:'Dmitri Volkov', first:'Dmitri', rel:'climbing partner', last:'2026-08-03', held:1633, waiting:7, cursor:91560, stamp:'7 unread', stampBlue:true,
    facts:[ {t:'Booked the Bishop trip for Labor Day weekend, needs a fourth.', cite:{a:91544,b:91560}},
            {t:'Tore a pulley in June — climbing easy for now.', cite:{a:83010}} ] },
  { slug:'sofia-herrera', name:'Sofia Herrera', first:'Sofia', rel:'coworker → friend', last:'2026-08-02', held:4102, waiting:2, cursor:91201,
    facts:[ {t:'Left the startup, joining a design studio in September.', cite:{a:91188,b:91201}},
            {t:'Owes you a book — “The Order of Time”.', cite:{a:74550}} ] },
  { slug:'marcus-bell', name:'Marcus Bell', first:'Marcus', rel:'friend · from the co-op', last:'2026-07-31', held:988, waiting:0, cursor:90980,
    facts:[ {t:'Fostering two kittens; asked if you want one.', cite:{a:90940,b:90980}} ] },
  { slug:'yuki-tanaka', name:'Yuki Tanaka', first:'Yuki', rel:'friend · Tokyo', last:'2026-07-29', held:2456, waiting:19, cursor:90720, stamp:'19 unread', stampBlue:true,
    facts:[ {t:'In SF for two weeks in August — wants to see the coast.', cite:{a:90700,b:90720}},
            {t:'Uses disappearing messages; 12 of hers are held only here.', cite:{n:'12 held only here', ox:true}} ] },
  { slug:'hassan-ali', name:'Hassan Ali', first:'Hassan', rel:'friend · roommate ’23', last:'2026-07-24', held:5210, waiting:0, cursor:89600,
    facts:[ {t:'Got engaged; wedding next spring in Amman.', cite:{a:89540,b:89600,p:89571}} ] },
  { slug:'grace-okoro', name:'Grace Okoro', first:'Grace', rel:'friend · book club', last:'2026-07-20', held:1344, waiting:0, cursor:88100,
    facts:[ {t:'Picked the next book; hosting on the 22nd.', cite:{a:88060,b:88100}} ] },
  { slug:'theo-lindqvist', name:'Theo Lindqvist', first:'Theo', rel:'friend · founder', last:'2026-07-16', held:3901, waiting:0, cursor:86800,
    facts:[ {t:'Raised a seed round; hiring two engineers.', cite:{a:86740,b:86800}},
            {t:'Asked you to intro him to Nigesh.', cite:{a:86790}} ] },
  { slug:'nadia-petrov', name:'Nadia Petrov', first:'Nadia', rel:'friend · violinist', last:'2026-07-12', held:770, waiting:0, cursor:85300, facts:[] },
  { slug:'omar-haddad', name:'Omar Haddad', first:'Omar', rel:'friend · pickup soccer', last:'2026-07-08', held:1188, waiting:3, cursor:84200, stamp:'3 unread', stampBlue:true,
    facts:[ {t:'Moving the Sunday game to 10am for the summer.', cite:{a:84180,b:84200}} ] },
  { slug:'bianca-rossi', name:'Bianca Rossi', first:'Bianca', rel:'friend · Milan', last:'2026-07-02', held:2033, waiting:0, cursor:83600,
    facts:[ {t:'Opening a ceramics studio; wants photos of your mugs.', cite:{a:83560,b:83600}} ] },
  { slug:'kofi-mensah', name:'Kofi Mensah', first:'Kofi', rel:'friend · former manager', last:'2026-06-27', held:1502, waiting:0, cursor:82100,
    facts:[ {t:'Now advising two startups; open to introductions.', cite:{a:82060,b:82100}} ] },
  { slug:'lena-fischer', name:'Lena Fischer', first:'Lena', rel:'friend · from Berlin', last:'2026-06-21', held:640, waiting:0, cursor:80900, facts:[] },
  { slug:'raj-malhotra', name:'Raj Malhotra', first:'Raj', rel:'cousin', last:'2026-06-14', held:6120, waiting:0, cursor:79000,
    facts:[ {t:'Family reunion is Thanksgiving in Chicago this year.', cite:{a:78940,b:79000}},
            {t:'Still owes you $200 from the Vegas trip.', cite:{n:'unsettled', ox:true}} ] },
  { slug:'chloe-dubois', name:'Chloe Dubois', first:'Chloe', rel:'friend · photographer', last:'2026-06-05', held:915, waiting:0, cursor:76400,
    facts:[ {t:'Shooting a wedding in Sonoma; free the week after.', cite:{a:76360,b:76400}} ] },
  { slug:'sam-whitfield', name:'Sam Whitfield', first:'Sam', rel:'friend · high school', last:'2026-05-12', held:388, waiting:0, cursor:60200, facts:[] },
];

// "Bring this up" — the radar/todo list, soonest first. status: go|soon|missed|quiet
const TODO = [
  { when:'2026-08-06', who:'Katia', slug:'katia-jacoby', what:'Ask how the Bridgewater phone interview went', cite:{a:91702,b:91711}, status:'go' },
  { when:'2026-08-08', who:'Charles', slug:'charles-wu', what:'Resale tickets through Michael — $300, Saturday only, you owe him cash', cite:{a:91788}, status:'soon' },
  { when:'2026-08-15', who:'Ken', slug:'ken-chessmore', what:'Pick him up from the subway station — you said you would', cite:{a:91720}, status:'soon', flag:true },
  { when:'2026-08-01', who:'Nigesh', slug:'nigesh-chakraborty', what:'He moved into the downtown Berkeley studio — ask how it went', cite:{a:90544,b:90558}, status:'missed' },
  { when:'2026-07-26', who:'Arnav', slug:'arnav-gupta', what:'Sign up for Builders, and send him builders.cv', cite:{a:91036}, status:'missed' },
  { when:'today', who:'Pine', slug:'pine-nguyen', what:'He wanted to try Opus 5 — you have it running', cite:{a:89514}, status:'go' },
];

// runs: {t, pass, scope, examined, held, took, mark, note}
const RUNS = [
  { t:'00:14:38', pass:'deep sweep', scope:'everyone', examined:'90,694', held:'669', took:'41 s', mark:'sw', note:'669 were stuck behind their cursors' },
  { t:'00:13:02', pass:'sweep', scope:'pine-nguyen', examined:'3,029', held:'99', took:'6 s', mark:'sw', note:'34 of his exist nowhere else' },
  { t:'00:11:47', pass:'deep sweep', scope:'everyone', examined:'—', held:'—', took:'3 s', mark:'held', note:'a page load had the file open' },
  { t:'00:13:40', pass:'backup', scope:'archive', examined:'83,878', held:'—', took:'11 s', mark:'sw', note:'17.5 MB, three kept' },
  { t:'Aug 3 · 16:49', pass:'read', scope:'nigesh-chakraborty', examined:'4,323', held:'6 ch.', took:'14 m', mark:'rd', note:'six weeks, one week at a time · opus-5' },
  { t:'Jul 30 · 04:33', pass:'read', scope:'everyone', examined:'2,190', held:'11 ch.', took:'38 m', mark:'rd', note:'scheduled weekly pass' },
  { t:'hourly ×23', pass:'sweep', scope:'everyone', examined:'—', held:'0', took:'<2 s', mark:'held', note:'nothing new since midnight' },
];

// One full profile for /c/pine-nguyen.
const PROFILE = {
  slug:'pine-nguyen', name:'Pine Nguyen', rel:'friend · builds an AI recruiting product',
  fields:{ 'Relationship':'friend', 'Last contact':'2026-08-05', 'Messages':'3,063 held · 34 rescued', 'How we met':'through Nigesh, 2025' },
  know:[
    { t:'Building an AI recruiter; interviews candidates himself and trusts his own read over the résumé.', cite:{a:90211,b:90219,p:90215} },
    { t:'Runs Kimi K3 in production, weighing a switch to Opus 5.', cite:{a:89514} },
    { t:'Uses disappearing messages by default — 34 of his messages exist only in this archive.', cite:{a:89510,b:89515}, ox:true },
    { t:'Direct to the point of blunt; reads bluntness back as honesty, not offence.', cite:{a:91827,b:91833} },
  ],
  bring:[
    { d:'Aug 6', t:'Ask how the candidate call went — he was reluctant about the fit.', cite:{a:91822,b:91826} },
    { d:null, t:'He wanted to try Opus 5 in Claude Code. You have it running.', cite:{a:89514} },
  ],
  open:[
    { t:'Did his CTO’s bad read on the candidate change how he hires?' },
    { t:'Is he still on K3 or did he switch?' },
  ],
  timeline:[
    { when:'2026-07', t:'Compared notes on K3 vs Opus 5; both curious, neither committed.', cite:{a:89510,b:89515} },
    { when:'2026-06', t:'Shipped the first version of the recruiter; started interviewing candidates directly.' },
    { when:'2026-05', t:'Left his last role; began building full-time.' },
  ],
  charge:[
    { who:'Pine', me:false, t:'have you tried kimi k3 model', cite:89510 },
    { who:'Nathan', me:true, t:'nah i havent, heard its good though', cite:89511 },
    { who:'Pine', me:false, t:'you should try opus 5', cite:89514 },
  ],
};

const MESSAGE_CONTEXT = [
  { who: 'Pine', me: false, id: 89508, t: 'work is insane rn' },
  { who: 'Pine', me: false, id: 89510, t: 'have you tried kimi k3 model', hit: true },
  { who: 'Nathan', me: true, id: 89511, t: 'nah i havent' },
  { who: 'Pine', me: false, id: 89512, t: 'heard its actually pretty good' },
  { who: 'Nathan', me: true, id: 89513, t: 'ye i heard as well' },
  { who: 'Pine', me: false, id: 89514, t: 'you should try opus 5' },
  { who: 'Nathan', me: true, id: 89515, t: 'is it in claude code' },
];

module.exports = { HEALTH, CONTACTS, TODO, RUNS, PROFILE, MESSAGE_CONTEXT };
