import React, { useState, useEffect, useCallback } from 'react';
import { Navbar } from './components/Navbar';
import { MetricsStrip } from './components/MetricsStrip';
import { ScenarioControls } from './components/ScenarioControls';
import { GraphCanvas } from './components/GraphCanvas';
import { DetectedRingsTable } from './components/DetectedRingsTable';
import { LatencyChart } from './components/LatencyChart';
import { LiveFeedTable } from './components/LiveFeedTable';
import { TransactionDrawer } from './components/TransactionDrawer';
import { SendMoneyView } from './components/SendMoneyView';
import {
  fetchMetrics,
  fetchGraph,
  fetchRecentTransactions,
  runScenario,
  resetSystem,
  subscribeToLiveStream,
} from './services/api';
import type {
  OperationalMetrics,
  GraphNode,
  GraphEdge,
  DetectedRing,
  ScoredTransaction,
  LatencyHistoryPoint,
} from './types/fraud';

const initialMetrics: OperationalMetrics = {
  total_txns: 0,
  avg_latency_ms: 0,
  p99_latency_ms: 0,
  tps: 0,
  allowed: 0,
  review: 0,
  blocked: 0,
  rings_detected: 0,
};

export const App: React.FC = () => {
  // Navigation
  const [currentTab, setCurrentTab] = useState<'dashboard' | 'pay'>(() => {
    return window.location.pathname === '/pay' ? 'pay' : 'dashboard';
  });

  const handleSelectTab = (tab: 'dashboard' | 'pay') => {
    setCurrentTab(tab);
    const newPath = tab === 'pay' ? '/pay' : '/';
    window.history.pushState({}, '', newPath);
  };

  useEffect(() => {
    const handlePopState = () => {
      setCurrentTab(window.location.pathname === '/pay' ? 'pay' : 'dashboard');
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // System states
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'reconnecting'>('reconnecting');
  const [metrics, setMetrics] = useState<OperationalMetrics>(initialMetrics);
  const [graphNodes, setGraphNodes] = useState<GraphNode[]>([]);
  const [graphEdges, setGraphEdges] = useState<GraphEdge[]>([]);
  const [detectedRings, setDetectedRings] = useState<DetectedRing[]>([]);
  const [transactions, setTransactions] = useState<ScoredTransaction[]>([]);
  const [selectedTxn, setSelectedTxn] = useState<ScoredTransaction | null>(null);

  // Scenario execution state
  const [isScenarioRunning, setIsScenarioRunning] = useState<boolean>(false);
  const [scenarioStatus, setScenarioStatus] = useState<string | null>(null);

  // Latency chart history (rolling 30 points)
  const [latencyHistory, setLatencyHistory] = useState<LatencyHistoryPoint[]>([]);

  // Push new transaction to live feed
  const handleIncomingTransaction = useCallback((newTxn: ScoredTransaction) => {
    const txnWithFlag = { ...newTxn, isNew: true };

    setTransactions((prev) => {
      // Keep up to 100 recent transactions
      const updated = [txnWithFlag, ...prev.filter((t) => t.txn_id !== newTxn.txn_id)].slice(0, 100);
      return updated;
    });

    // Append latency sample
    const timeStr = new Date().toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    setLatencyHistory((prev) => {
      const next = [...prev, { time: timeStr, latency: newTxn.latency_ms }];
      return next.slice(-30);
    });
  }, []);

  // Initial load & Polling
  const loadData = useCallback(async () => {
    try {
      const [m, g, txns] = await Promise.all([
        fetchMetrics(),
        fetchGraph(),
        fetchRecentTransactions(),
      ]);

      setMetrics(m);
      setGraphNodes(g.nodes);
      setGraphEdges(g.edges);
      setDetectedRings(g.rings);
      setTransactions((prev) => {
        if (prev.length === 0) return txns;
        // Keep existing if already receiving websocket stream
        return prev;
      });

      // Populate latency history from recent transactions if not already populated
      setLatencyHistory((prev) => {
        if (prev.length === 0 && txns.length > 0) {
          return txns
            .slice(0, 30)
            .reverse()
            .map((t) => ({
              time: new Date(t.timestamp).toLocaleTimeString('en-US', {
                hour12: false,
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              }),
              latency: t.latency_ms,
            }));
        }
        return prev;
      });
    } catch {
      // Silent error during polling; connection indicator handles UI feedback
    }
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 2000);
    return () => clearInterval(interval);
  }, [loadData]);

  // WebSocket live feed subscription
  useEffect(() => {
    const unsubscribe = subscribeToLiveStream(
      (txn) => {
        handleIncomingTransaction(txn);
        // Instant metric bump
        setMetrics((prev) => ({
          ...prev,
          total_txns: prev.total_txns + 1,
          allowed: txn.decision === 'ALLOW' ? prev.allowed + 1 : prev.allowed,
          review: txn.decision === 'REVIEW' ? prev.review + 1 : prev.review,
          blocked: txn.decision === 'BLOCK' ? prev.blocked + 1 : prev.blocked,
        }));
      },
      (status) => {
        setConnectionStatus(status);
      }
    );

    return () => unsubscribe();
  }, [handleIncomingTransaction]);

  // Run scenario handler
  const handleRunScenario = async (scenario: string, label: string) => {
    setIsScenarioRunning(true);
    setScenarioStatus(`Running ${label}...`);

    try {
      const res = await runScenario(scenario);
      setScenarioStatus(
        `${label}: ${res.count} sent, ${res.allowed} allowed, ${res.review} review, ${res.blocked} blocked`
      );
      // Refresh metrics and graph immediately
      await loadData();
    } catch (err: any) {
      setScenarioStatus(`Failed to run ${label}: ${err.message}`);
    } finally {
      setIsScenarioRunning(false);
    }
  };

  // Reset handler
  const handleReset = async () => {
    setIsScenarioRunning(true);
    setScenarioStatus('Resetting system state...');
    try {
      await resetSystem();
      setTransactions([]);
      setLatencyHistory([]);
      setSelectedTxn(null);
      await loadData();
      setScenarioStatus('State, metrics, and network graph reset');
    } catch (err: any) {
      setScenarioStatus(`Reset failed: ${err.message}`);
    } finally {
      setIsScenarioRunning(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F4F5F7] text-[#1B2433] flex flex-col font-sans">
      <Navbar
        currentTab={currentTab}
        onSelectTab={handleSelectTab}
        connectionStatus={connectionStatus}
      />

      {currentTab === 'pay' ? (
        <SendMoneyView />
      ) : (
        <main className="max-w-[1440px] w-full mx-auto px-4 py-4 space-y-4 flex-1">
          {/* Unified Metrics Strip */}
          <section aria-label="Operational Metrics">
            <MetricsStrip metrics={metrics} />
          </section>

          {/* Scenario Controls */}
          <section aria-label="Scenario Controls">
            <ScenarioControls
              onRunScenario={handleRunScenario}
              onReset={handleReset}
              isRunning={isScenarioRunning}
              statusMessage={scenarioStatus}
            />
          </section>

          {/* Main 2-Column Split: 65% Graph/Rings/Latency, 35% Live Feed */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
            {/* Left 65% Column */}
            <div className="lg:col-span-8 space-y-4">
              {/* Account Network Graph */}
              <GraphCanvas
                nodes={graphNodes}
                edges={graphEdges}
                rings={detectedRings}
              />

              {/* Sub-grid: Detected Rings & Latency Chart */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <DetectedRingsTable rings={detectedRings} />
                <LatencyChart data={latencyHistory} currentAvg={metrics.avg_latency_ms} />
              </div>
            </div>

            {/* Right 35% Column: Live Feed */}
            <div className="lg:col-span-4 h-full">
              <LiveFeedTable
                transactions={transactions}
                selectedTxn={selectedTxn}
                onSelectTxn={setSelectedTxn}
              />
            </div>
          </div>
        </main>
      )}

      {/* Transaction Details Slide-over Drawer */}
      <TransactionDrawer
        transaction={selectedTxn}
        onClose={() => setSelectedTxn(null)}
      />
    </div>
  );
};

export default App;
