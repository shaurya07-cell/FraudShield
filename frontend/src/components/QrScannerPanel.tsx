import React, { useState, useRef, useEffect, useCallback } from 'react';
import jsQR from 'jsqr';

export interface DecodedUpiData {
  pa: string; // payee address / VPA
  pn?: string; // payee name
  am?: string; // amount
  cu?: string; // currency
  rawString: string;
}

interface QrScannerPanelProps {
  onUpiDecoded: (data: DecodedUpiData) => void;
  onClose?: () => void;
  initialTab?: 'camera' | 'upload';
}

export const QrScannerPanel: React.FC<QrScannerPanelProps> = ({
  onUpiDecoded,
  onClose,
  initialTab = 'camera',
}) => {
  const [activeTab, setActiveTab] = useState<'camera' | 'upload'>(initialTab);
  const [qrError, setQrError] = useState<string | null>(null);
  const [cameraWarning, setCameraWarning] = useState<string | null>(null);
  const [isTorchOn, setIsTorchOn] = useState(false);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [isScanning, setIsScanning] = useState(false);
  const [scanSuccess, setScanSuccess] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Check secure context for camera access
  const isSecure = typeof window !== 'undefined' && (
    window.isSecureContext ||
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1'
  );

  const stopCamera = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setIsScanning(false);
  }, []);

  // UPI QR parser
  const parseAndValidateUpi = useCallback((rawString: string): boolean => {
    setQrError(null);
    const trimmed = rawString.trim();

    // Standard UPI URI format: upi://pay?pa=...
    if (trimmed.toLowerCase().startsWith('upi://pay?')) {
      try {
        const queryPart = trimmed.slice(trimmed.indexOf('?') + 1);
        const params = new URLSearchParams(queryPart);

        const pa = params.get('pa');
        const pn = params.get('pn') || undefined;
        const am = params.get('am') || undefined;
        const cu = params.get('cu') || 'INR';

        if (!pa) {
          setQrError('QR code is missing receiver address.');
          return false;
        }

        setScanSuccess(true);
        if (typeof navigator !== 'undefined' && navigator.vibrate) {
          navigator.vibrate(50);
        }

        setTimeout(() => {
          onUpiDecoded({
            pa,
            pn: pn ? decodeURIComponent(pn) : undefined,
            am,
            cu,
            rawString: trimmed,
          });
        }, 250);

        return true;
      } catch {
        setQrError('Failed to parse UPI payment QR data.');
        return false;
      }
    }

    // Direct account identifier or VPA fallback
    const vpaRegex = /^[a-zA-Z0-9.\-_]+@[a-zA-Z0-9]+$/;
    const accRegex = /^[a-zA-Z0-9_-]{3,30}$/;
    if (vpaRegex.test(trimmed) || accRegex.test(trimmed)) {
      setScanSuccess(true);
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate(50);
      }

      setTimeout(() => {
        onUpiDecoded({
          pa: trimmed,
          pn: trimmed,
          rawString: `upi://pay?pa=${encodeURIComponent(trimmed)}&cu=INR`,
        });
      }, 250);

      return true;
    }

    setQrError('Unrecognized QR format. Please scan a standard payment QR.');
    return false;
  }, [onUpiDecoded]);

  // Frame processing loop
  const scanCameraFrame = useCallback(() => {
    if (!videoRef.current || videoRef.current.readyState !== videoRef.current.HAVE_ENOUGH_DATA) {
      animFrameRef.current = requestAnimationFrame(scanCameraFrame);
      return;
    }

    if (!canvasRef.current) {
      canvasRef.current = document.createElement('canvas');
    }
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const video = videoRef.current;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    if (ctx) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height);

      if (code && code.data) {
        const success = parseAndValidateUpi(code.data);
        if (success) {
          stopCamera();
          return;
        }
      }
    }

    animFrameRef.current = requestAnimationFrame(scanCameraFrame);
  }, [parseAndValidateUpi, stopCamera]);

  // Start video stream
  const startCamera = useCallback(async () => {
    setQrError(null);
    setCameraWarning(null);

    if (!isSecure) {
      setCameraWarning('Camera requires HTTPS or localhost. Use gallery upload below.');
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraWarning('Camera access is not supported on this device/browser.');
      return;
    }

    try {
      stopCamera();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: facingMode },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.setAttribute('playsinline', 'true');
        await videoRef.current.play();
        setIsScanning(true);
        scanCameraFrame();
      }
    } catch (err: any) {
      stopCamera();
      setCameraWarning(
        err.name === 'NotAllowedError'
          ? 'Camera permission denied. Enable permissions or upload a QR image.'
          : 'Could not activate camera. Please select a QR image.'
      );
    }
  }, [facingMode, isSecure, scanCameraFrame, stopCamera]);

  useEffect(() => {
    if (activeTab === 'camera') {
      startCamera();
    } else {
      stopCamera();
    }
    return () => {
      stopCamera();
    };
  }, [activeTab, facingMode, startCamera, stopCamera]);

  // File upload reader
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setQrError(null);
    const reader = new FileReader();

    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        if (!canvasRef.current) {
          canvasRef.current = document.createElement('canvas');
        }
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          setQrError('Image decoding is unavailable.');
          return;
        }

        canvas.width = img.width;
        canvas.height = img.height;
        ctx.drawImage(img, 0, 0, img.width, img.height);

        const imageData = ctx.getImageData(0, 0, img.width, img.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height);

        if (code && code.data) {
          parseAndValidateUpi(code.data);
        } else {
          setQrError('No readable QR code found in this image. Ensure the code is in focus.');
        }
      };

      img.onerror = () => {
        setQrError('Unable to open image file.');
      };

      img.src = event.target?.result as string;
    };

    reader.readAsDataURL(file);
    e.target.value = '';
  };

  // Torch toggle
  const toggleTorch = async () => {
    if (!streamRef.current) return;
    const track = streamRef.current.getVideoTracks()[0];
    if (!track) return;

    try {
      const capabilities = (track.getCapabilities && track.getCapabilities()) as any;
      if (capabilities && capabilities.torch) {
        const nextState = !isTorchOn;
        await track.applyConstraints({
          advanced: [{ torch: nextState } as any],
        });
        setIsTorchOn(nextState);
      } else {
        setIsTorchOn((prev) => !prev);
      }
    } catch {
      setIsTorchOn((prev) => !prev);
    }
  };

  // Camera flip
  const toggleFacingMode = () => {
    setFacingMode((prev) => (prev === 'environment' ? 'user' : 'environment'));
  };

  // One-click sample QR triggers
  const handleQuickSample = (pa: string, pn: string, am: string) => {
    parseAndValidateUpi(`upi://pay?pa=${encodeURIComponent(pa)}&pn=${encodeURIComponent(pn)}&am=${encodeURIComponent(am)}&cu=INR`);
  };

  return (
    <div className="w-full bg-[#121824] text-white rounded-[10px] overflow-hidden shadow-xl border border-[#232D42]">
      {/* Reticle laser keyframes */}
      <style>{`
        @keyframes scanLaser {
          0% { transform: translateY(0); opacity: 0.8; }
          50% { transform: translateY(188px); opacity: 1; }
          100% { transform: translateY(0); opacity: 0.8; }
        }
        .scanner-laser {
          animation: scanLaser 2.2s ease-in-out infinite;
        }
      `}</style>

      {/* Top Header Bar */}
      <div className="px-4 py-3 bg-[#17202E] border-b border-[#232D42] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-[#1F4FD8] flex items-center justify-center text-white">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
            </svg>
          </div>
          <div>
            <div className="text-[13px] font-semibold text-white tracking-tight">Scan UPI QR Code</div>
            <div className="text-[10px] text-white/60">Instant Receiver Detection</div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Method Pill */}
          <div className="flex bg-[#0B101B] p-0.5 rounded-[6px] border border-white/10 text-[11px]">
            <button
              type="button"
              onClick={() => setActiveTab('camera')}
              className={`px-2.5 py-1 rounded-[4px] font-medium transition-colors ${
                activeTab === 'camera' ? 'bg-[#1F4FD8] text-white shadow-xs' : 'text-white/60 hover:text-white'
              }`}
            >
              Camera
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('upload')}
              className={`px-2.5 py-1 rounded-[4px] font-medium transition-colors ${
                activeTab === 'upload' ? 'bg-[#1F4FD8] text-white shadow-xs' : 'text-white/60 hover:text-white'
              }`}
            >
              Gallery
            </button>
          </div>

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="w-7 h-7 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white/80 transition-colors"
              aria-label="Close scanner"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Error Alert */}
      {qrError && (
        <div className="px-4 py-2 bg-[#C0362C]/20 border-b border-[#C0362C]/30 text-[12px] text-[#FCA5A5] flex items-center gap-2">
          <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span>{qrError}</span>
        </div>
      )}

      {/* ─── Mode 1: Camera Viewfinder ─── */}
      {activeTab === 'camera' && (
        <div className="relative bg-[#0B101B] h-[320px] flex items-center justify-center overflow-hidden">
          {cameraWarning ? (
            <div className="p-6 text-center max-w-sm space-y-3">
              <div className="w-12 h-12 mx-auto rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-white/60">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </div>
              <div className="text-[13px] font-medium text-white">{cameraWarning}</div>
              <button
                type="button"
                onClick={() => setActiveTab('upload')}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-[#1F4FD8] hover:bg-[#183EB0] text-white text-[12px] font-medium rounded-[6px] transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <span>Upload QR from Gallery</span>
              </button>
            </div>
          ) : (
            <>
              {/* Live Video Feed */}
              <video
                ref={videoRef}
                className="absolute inset-0 w-full h-full object-cover"
                autoPlay
                muted
                playsInline
              />

              {/* Viewfinder Reticle Overlay */}
              <div className="absolute inset-0 bg-[#000000]/40 flex flex-col items-center justify-center pointer-events-none">
                <div className={`relative w-[200px] h-[200px] transition-all duration-300 ${scanSuccess ? 'scale-105' : ''}`}>
                  {/* High contrast brackets */}
                  <div className={`absolute top-0 left-0 w-7 h-7 border-t-[3px] border-l-[3px] rounded-tl-[6px] ${scanSuccess ? 'border-[#10B981]' : 'border-white'}`} />
                  <div className={`absolute top-0 right-0 w-7 h-7 border-t-[3px] border-r-[3px] rounded-tr-[6px] ${scanSuccess ? 'border-[#10B981]' : 'border-white'}`} />
                  <div className={`absolute bottom-0 left-0 w-7 h-7 border-b-[3px] border-l-[3px] rounded-bl-[6px] ${scanSuccess ? 'border-[#10B981]' : 'border-white'}`} />
                  <div className={`absolute bottom-0 right-0 w-7 h-7 border-b-[3px] border-r-[3px] rounded-br-[6px] ${scanSuccess ? 'border-[#10B981]' : 'border-white'}`} />

                  {/* Scanning Laser Beam */}
                  {isScanning && !scanSuccess && (
                    <div className="scanner-laser absolute left-1 right-1 h-[2px] bg-gradient-to-r from-transparent via-[#60A5FA] to-transparent shadow-[0_0_10px_#3B82F6]" />
                  )}

                  {scanSuccess && (
                    <div className="absolute inset-0 flex items-center justify-center bg-[#10B981]/20 rounded-[6px] backdrop-blur-2xs">
                      <svg className="w-12 h-12 text-[#10B981] animate-in zoom-in-75 duration-200" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                  )}
                </div>

                <div className="mt-4 text-[11px] text-white/90 font-medium tracking-wide bg-black/60 px-3 py-1 rounded-full backdrop-blur-xs border border-white/10">
                  {scanSuccess ? 'QR Code Scanned!' : 'Align QR code inside the frame'}
                </div>
              </div>

              {/* Floating Camera Actions */}
              <div className="absolute top-3 left-3 right-3 flex items-center justify-between z-10">
                <div className="flex items-center gap-1.5 px-2.5 py-1 bg-black/60 backdrop-blur-xs rounded-full text-white text-[11px] font-medium border border-white/10">
                  <span className={`w-2 h-2 rounded-full ${isScanning ? 'bg-[#10B981] animate-pulse' : 'bg-yellow-400'}`} />
                  <span>{isScanning ? 'Scanner Active' : 'Connecting...'}</span>
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={toggleTorch}
                    className={`w-8 h-8 rounded-full backdrop-blur-xs flex items-center justify-center transition-colors ${
                      isTorchOn ? 'bg-[#F59E0B] text-black' : 'bg-black/60 text-white hover:bg-black/80'
                    }`}
                    title="Toggle Flashlight"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                  </button>

                  <button
                    type="button"
                    onClick={toggleFacingMode}
                    className="w-8 h-8 rounded-full bg-black/60 text-white hover:bg-black/80 backdrop-blur-xs flex items-center justify-center transition-colors"
                    title="Flip Camera"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ─── Mode 2: Gallery Image Upload ─── */}
      {activeTab === 'upload' && (
        <div className="p-6 bg-[#0B101B]">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileUpload}
            className="hidden"
          />

          <div
            onClick={() => fileInputRef.current?.click()}
            className="w-full py-8 px-4 border-2 border-dashed border-[#232D42] hover:border-[#1F4FD8] rounded-[10px] bg-[#121824]/60 hover:bg-[#121824] text-center transition-all cursor-pointer group"
          >
            <div className="w-12 h-12 mx-auto rounded-full bg-[#1F4FD8]/10 text-[#1F4FD8] flex items-center justify-center mb-3 group-hover:scale-110 transition-transform">
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
            <div className="text-[14px] font-semibold text-white group-hover:text-[#60A5FA] transition-colors">
              Upload QR code from gallery
            </div>
            <div className="text-[11px] text-white/50 mt-1">
              Select any screenshot or photo containing a UPI payment QR
            </div>
            <button
              type="button"
              className="mt-4 px-4 py-1.5 bg-[#1F4FD8] text-white text-[12px] font-medium rounded-[6px] hover:bg-[#183EB0] transition-colors"
            >
              Browse Files
            </button>
          </div>
        </div>
      )}

      {/* ─── Footer: Quick Test Sample QRs ─── */}
      <div className="px-4 py-2.5 bg-[#0E1522] border-t border-[#232D42] flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-[11px]">
        <span className="text-white/60 font-medium">Quick Demo QRs:</span>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => handleQuickSample('ACC_0015', 'Demo Account', '500')}
            className="px-2 py-0.5 bg-[#1A2333] hover:bg-[#253248] text-white/90 hover:text-white rounded-[4px] font-mono transition-colors border border-white/10"
          >
            ACC_0015 (₹500)
          </button>
          <button
            type="button"
            onClick={() => handleQuickSample('ACC_0042', 'Demo Account', '1250')}
            className="px-2 py-0.5 bg-[#1A2333] hover:bg-[#253248] text-white/90 hover:text-white rounded-[4px] font-mono transition-colors border border-white/10"
          >
            ACC_0042 (₹1,250)
          </button>
          <button
            type="button"
            onClick={() => handleQuickSample('success@razorpay', 'Razorpay Test Payee', '2500')}
            className="px-2 py-0.5 bg-[#1A2333] hover:bg-[#253248] text-white/90 hover:text-white rounded-[4px] font-mono transition-colors border border-white/10"
          >
            Razorpay (₹2,500)
          </button>
        </div>
      </div>
    </div>
  );
};
