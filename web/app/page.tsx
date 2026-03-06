import { Reveal } from "../components/reveal";
import { BenchmarkTerminal } from "../components/benchmark-terminal";
import { TerminalDemo } from "../components/terminal-demo";

const capabilities = [
  {
    title: "Replayable Execution",
    body: "Record agent runs and replay them as deterministic workflows.",
  },
  {
    title: "Policy Loop",
    body: "Memory influences tool routing. Rules and feedback shape behaviour over time.",
  },
  {
    title: "Layered Context",
    body: "Context assembled in layers: facts, episodes, rules, tools, citations.",
  },
  {
    title: "Repair & Promotion",
    body: "When a replay fails: repair, shadow validation, promotion.",
  },
];

const useCases = [
  "install development environments",
  "deploy docker stacks",
  "configure coding agents",
  "automate research workflows",
  "setup local AI tooling",
];

const pipeline = ["run", "execution trace", "compile playbook", "replay", "repair", "promote"];

const benchmarkKpis = [
  { label: "Workflow Cases", value: "100" },
  { label: "Compile Success", value: "98%" },
  { label: "Replay Stability (R1→R2)", value: "98%" },
  { label: "Replay Speedup (R2 vs baseline)", value: "16.51x" },
];

const benchmarkCi = [
  { label: "Compile success", point: 98, lo: 93.0, hi: 99.4 },
  { label: "Replay stability", point: 98, lo: 93.0, hi: 99.4 },
];

const latestReleaseTag = "v0.1.3";
const latestNpmVersion = "0.1.3";

export default function HomePage() {
  return (
    <>
      <div className="ambientStars" aria-hidden />
      <div className="ambientNebula" aria-hidden />



      <main id="top" className="shell">
        {/* ── Hero ── */}
        <section className="hero">
          <Reveal>
            <div className="heroSigil" aria-hidden>
              Aionis
            </div>
          </Reveal>
          <Reveal>
            <h1 className="title title-main">Teach your agent once. Let it replay forever.</h1>
          </Reveal>
          <Reveal delay={0.04}>
            <p className="eyebrow">Aionis turns agent execution into reusable workflows.</p>
          </Reveal>
          <Reveal delay={0.06}>
            <p className="releasePill">
              Latest release: <a href="https://github.com/Cognary/aionis-openclaw-plugin/releases/tag/v0.1.3" target="_blank" rel="noreferrer">{latestReleaseTag}</a>
              <i>·</i>
              NPM: <a href="https://www.npmjs.com/package/@aionis/openclaw-aionis-memory" target="_blank" rel="noreferrer">{latestNpmVersion}</a>
            </p>
          </Reveal>
          <Reveal delay={0.08}>
            <p className="heroBody">
              Most memory plugins focus on conversations.<br />
              Aionis also records what the agent actually did and allows the workflow to be replayed later.
            </p>
          </Reveal>
          <Reveal delay={0.16} className="heroButtons" variant="scale">
            <a className="btn btnPrimary" href="#install">
              Install Plugin
            </a>
            <a className="btn" href="https://github.com/Cognary/aionis-openclaw-plugin" target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a className="btn" href="https://github.com/Cognary/aionis-openclaw-plugin/blob/main/README.md" target="_blank" rel="noreferrer">
              Docs
            </a>
          </Reveal>
        </section>

        {/* ── Quickstart Code ── */}
        <Reveal delay={0.25} variant="scale">
          <div className="heroCodeStage">
            <div className="codeHead">
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
              <strong>Replay Execution Session</strong>
            </div>
            <div className="heroCodeBody">
              <pre>{`$ agent.run("install clawbot")
trace_id: trc_0192
playbook_id: pbk_0f21
replay.mode: guided
policy.guardrails: enabled
repair.shadow_validation: true
status: replay_success`}</pre>
              <aside className="heroCodeAside">
                <h4>Replay Signals</h4>
                <ul>
                  <li><span>trace_quality</span><b>stable</b></li>
                  <li><span>policy_score</span><b>0.97</b></li>
                  <li><span>repair_needed</span><b>no</b></li>
                  <li><span>promotion_ready</span><b>yes</b></li>
                </ul>
              </aside>
            </div>
            <div className="codeBadges">
              <span>overall_status: pass</span>
              <span>replay_status: pass</span>
              <span>demo_session_latency: 1.2s</span>
            </div>
            <p className="heroLatencyNote">
              Latency note: this is guided end-to-end demo session latency. Benchmark latency below reports replay-step averages (replay2_avg: 136.9ms).
            </p>
          </div>
        </Reveal>

        {/* ── Demo ── */}
        <section id="demo" className="section">
          <Reveal>
            <h2><span className="clawAccent">⟩</span> Watch an agent learn a workflow</h2>
          </Reveal>
          <div className="demoLayout">
            <Reveal delay={0.05}>
              <ol className="demoRail">
                <li><b>01</b><span>Agent installs Clawbot</span></li>
                <li><b>02</b><span>Execution trace recorded</span></li>
                <li><b>03</b><span>Playbook compiled</span></li>
                <li><b>04</b><span>Next run replays automatically</span></li>
              </ol>
            </Reveal>
            <Reveal delay={0.1} variant="scale">
              <TerminalDemo />
            </Reveal>
          </div>
          <Reveal delay={0.14}>
            <p className="sectionNote">
              Instead of re-reasoning every step, the agent simply reuses the workflow.
            </p>
          </Reveal>
        </section>

        {/* ── What it does + Pipeline ── */}
        <section className="section">
          <Reveal>
            <h2><span className="clawAccent">⟩</span> What Aionis actually does</h2>
          </Reveal>
          <Reveal delay={0.04}>
            <p className="sectionBody">
              Most agent memory systems store conversation history. Aionis stores execution history —
              turning one successful run into a reusable workflow.
            </p>
          </Reveal>
          <Reveal delay={0.08}>
            <div className="pipelineTrack">
              {pipeline.map((step, idx) => (
                <span key={step}>
                  {step}
                  {idx < pipeline.length - 1 ? <i>→</i> : null}
                </span>
              ))}
            </div>
          </Reveal>
          <Reveal delay={0.12}>
            <p className="sectionBody" style={{ marginTop: 24 }}>
              <strong>Today&apos;s agents:</strong> reason → act → forget. Every task is solved from scratch.<br />
              <strong>With Aionis:</strong> reason → act → remember → reuse. Agents become more stable over time.
            </p>
          </Reveal>
        </section>

        {/* ── Capabilities ── */}
        <section id="capabilities" className="section">
          <Reveal>
            <h2><span className="clawAccent">⟩</span> Core capabilities</h2>
          </Reveal>
          <div className="capGrid">
            {capabilities.map((item, idx) => (
              <Reveal key={item.title} delay={0.03 + idx * 0.04}>
                <div className="featureCard">
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </section>

        {/* ── Benchmark ── */}
        <section id="benchmark" className="section">
          <Reveal>
            <h2><span className="clawAccent">⟩</span> Benchmark: replay performance in real workflows</h2>
          </Reveal>
          <Reveal delay={0.04}>
            <p className="sectionBody">
              In a 100-case install/config benchmark, Aionis keeps replay reliability high while cutting runtime sharply after compile.
            </p>
          </Reveal>
          <Reveal delay={0.08} variant="scale">
            <BenchmarkTerminal />
          </Reveal>
          <div className="benchmarkGrid">
            {benchmarkKpis.map((item, idx) => (
              <Reveal key={item.label} delay={0.1 + idx * 0.03} variant="scale">
                <div className="benchmarkKpi">
                  <p>{item.label}</p>
                  <strong>{item.value}</strong>
                </div>
              </Reveal>
            ))}
          </div>
          <Reveal delay={0.2} variant="scale">
            <div className="benchmarkCard">
              <div className="codeHead">
                <span className="dot" />
                <span className="dot" />
                <span className="dot" />
                <strong>Benchmark Summary · run_id 20260305-162059-22132</strong>
              </div>
              <pre>{`baseline_avg: 2260.85ms
replay1_avg: 260.20ms  (8.69x faster than baseline)
replay2_avg: 136.90ms  (16.51x faster than baseline)
replay2_vs_replay1: -123.31ms (-47.4%)`}</pre>
              <div className="benchmarkCi">
                <p>95% confidence interval (Wilson)</p>
                {benchmarkCi.map((item) => (
                  <div key={item.label} className="benchmarkCiRow">
                    <div className="benchmarkCiLabel">
                      <span>{item.label}</span>
                      <b>{item.point}% · CI {item.lo}% - {item.hi}%</b>
                    </div>
                    <div className="benchmarkCiTrack">
                      <i className="benchmarkCiRange" style={{ left: `${item.lo}%`, width: `${item.hi - item.lo}%` }} />
                      <em className="benchmarkCiPoint" style={{ left: `${item.point}%` }} />
                    </div>
                  </div>
                ))}
              </div>
              <p className="benchmarkNote">
                <span className="benchmarkNoteText">
                  Method: each case runs baseline once, compiles once, then executes replay twice in strict workflow checks.
                  Per-case replay_reason is included when failures occur (for example: run_not_found, playbook_not_found).
                </span>
                <a href="https://github.com/Cognary/aionis-openclaw-plugin/blob/main/scripts/benchmark-replay-workflow.sh" target="_blank" rel="noreferrer"> View harness</a>
                <a href="/benchmarks/20260305-162059-22132/cases.jsonl" target="_blank" rel="noreferrer"> View cases.jsonl</a>
                <a href="/benchmarks/20260305-162059-22132/summary.json" target="_blank" rel="noreferrer"> View summary.json</a>
              </p>
            </div>
          </Reveal>
        </section>

        {/* ── Comparison ── */}
        <section id="comparison" className="section">
          <Reveal>
            <h2><span className="clawAccent">⟩</span> Memory plugins vs Aionis</h2>
          </Reveal>
          <Reveal delay={0.05} variant="scale">
            <div className="tableWrap">
              <table>
                <thead>
                  <tr>
                    <th>Capability</th>
                    <th>mem0</th>
                    <th>supermemory</th>
                    <th>Aionis</th>
                  </tr>
                </thead>
                <tbody>
                  <tr><td>Chat memory</td><td className="yes">✔</td><td className="yes">✔</td><td className="yes">✔</td></tr>
                  <tr><td>Vector recall</td><td className="yes">✔</td><td className="yes">✔</td><td className="yes">✔</td></tr>
                  <tr><td>Execution trace</td><td className="no">✘</td><td className="no">✘</td><td className="yes">✔</td></tr>
                  <tr><td>Replay workflows</td><td className="no">✘</td><td className="no">✘</td><td className="yes">✔</td></tr>
                  <tr><td>Policy loop</td><td className="no">✘</td><td className="no">✘</td><td className="yes">✔</td></tr>
                  <tr><td>Governed repair</td><td className="no">✘</td><td className="no">✘</td><td className="yes">✔</td></tr>
                </tbody>
              </table>
            </div>
          </Reveal>
          <Reveal delay={0.1}>
            <p className="sectionNote">Most memory plugins stop at retrieval. Aionis turns memory into automation.</p>
          </Reveal>
        </section>

        {/* ── Install ── */}
        <section id="install" className="section">
          <Reveal>
            <h2><span className="clawAccent">⟩</span> Install in 30 seconds</h2>
          </Reveal>
          <Reveal delay={0.04}>
            <p className="sectionBody">
              Install the OpenClaw plugin and give your agent replayable execution memory.
              <span className="installVersion">Latest stable: {latestReleaseTag}</span>
            </p>
          </Reveal>
          <Reveal delay={0.08} variant="scale">
            <div className="installCard">
              <div className="codeHead">
                <span className="dot" />
                <span className="dot" />
                <span className="dot" />
                <strong>Terminal</strong>
              </div>
              <pre>{`openclaw plugins install @aionis/openclaw-aionis-memory@0.1.3
openclaw aionis-memory bootstrap
openclaw aionis-memory selfcheck`}</pre>
            </div>
          </Reveal>
        </section>

        {/* ── Use Cases ── */}
        <section className="section">
          <Reveal>
            <h2><span className="clawAccent">⟩</span> What people use this for</h2>
          </Reveal>
          <div className="useGrid">
            {useCases.map((item, idx) => (
              <Reveal key={item} delay={0.04 + idx * 0.03}>
                <div className="useCard">{item}</div>
              </Reveal>
            ))}
          </div>
          <Reveal delay={0.12}>
            <p className="sectionNote">If an agent can do it once, it can replay it.</p>
          </Reveal>
        </section>

        {/* ── FAQ ── */}
        <section id="faq" className="section">
          <Reveal>
            <h2><span className="clawAccent">⟩</span> FAQ</h2>
          </Reveal>
          <div className="faqList">
            <Reveal delay={0.04}>
              <details className="faqItem">
                <summary>Is this just RAG memory?</summary>
                <p>No. RAG stores knowledge. Aionis stores execution. It records how the agent completed tasks and allows replay.</p>
              </details>
            </Reveal>
            <Reveal delay={0.08}>
              <details className="faqItem">
                <summary>Does this require cloud services?</summary>
                <p>No. Aionis can run locally in standalone mode.</p>
              </details>
            </Reveal>
            <Reveal delay={0.12}>
              <details className="faqItem">
                <summary>What agents are supported?</summary>
                <p>The OpenClaw plugin is available today. Other agent frameworks can integrate through the API.</p>
              </details>
            </Reveal>
            <Reveal delay={0.16}>
              <details className="faqItem">
                <summary>Is replay deterministic?</summary>
                <p>Replay supports simulate, strict, and guided modes. Guided replay can repair failed steps and promote improved workflows.</p>
              </details>
            </Reveal>
          </div>
        </section>

        {/* ── Footer ── */}
        <footer className="siteFooter">
          <p className="footerBrand">Aionis</p>
          <ul className="footerLinks">
            <li><a href="https://github.com/Cognary/aionis-openclaw-plugin" target="_blank" rel="noreferrer">GitHub</a></li>
            <li><a href="https://github.com/Cognary/aionis-openclaw-plugin/blob/main/README.md" target="_blank" rel="noreferrer">Docs</a></li>
            <li><a href="https://www.npmjs.com/package/@aionis/openclaw-aionis-memory" target="_blank" rel="noreferrer">NPM Plugin</a></li>
          </ul>
          <p className="disclaimer">Replayable execution. Policy-aware automation. Persistent agent memory.</p>
        </footer>
      </main>
    </>
  );
}
