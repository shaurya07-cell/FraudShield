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
}) => {
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
        setQrError('Failed to parse payment QR data.');
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
      setCameraWarning('Camera access requires HTTPS. Tap "Upload from gallery" below to select a QR image.');
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraWarning('Camera not supported on this device. Use gallery upload below.');
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
          ? 'Camera permission denied. Tap "Upload from gallery" below.'
          : 'Could not access camera. Please select a QR image from gallery.'
      );
    }
  }, [facingMode, isSecure, scanCameraFrame, stopCamera]);

  useEffect(() => {
    startCamera();
    return () => {
      stopCamera();
    };
  }, [facingMode, startCamera, stopCamera]);

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
          setQrError('No readable QR code found in this image. Please ensure the code is clear and well-lit.');
        }
      };

      img.onerror = () => {
        setQrError('Unable to open selected image.');
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

  // Quick sample triggers for instant desktop testing
  const handleQuickSample = (pa: string, pn: string, am: string) => {
    parseAndValidateUpi(`upi://pay?pa=${encodeURIComponent(pa)}&pn=${encodeURIComponent(pn)}&am=${encodeURIComponent(am)}&cu=INR`);
  };

  return (
    <div className="w-full bg-[#0A0F1D] text-white rounded-[16px] overflow-hidden shadow-2xl border border-white/10 relative">
      {/* Hidden file input for gallery picker */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileUpload}
        className="hidden"
      />

      {/* Laser line keyframes */}
      <style>{`
        @keyframes scanBeam {
          0% { top: 8px; opacity: 0.8; }
          50% { top: calc(100% - 10px); opacity: 1; }
          100% { top: 8px; opacity: 0.8; }
        }
        .scanner-beam {
          animation: scanBeam 2.2s cubic-bezier(0.4, 0, 0.2, 1) infinite;
        }
      `}</style>

      {/* Viewfinder Camera Stage */}
      <div className="relative min-h-[380px] sm:min-h-[420px] bg-[#050811] flex flex-col justify-between p-4 overflow-hidden">
        {/* Background Video */}
        {!cameraWarning && (
          <video
            ref={videoRef}
            className="absolute inset-0 w-full h-full object-cover"
            autoPlay
            muted
            playsInline
          />
        )}

        {/* Viewfinder Dark Overlay Vignette */}
        <div className="absolute inset-0 bg-black/45 pointer-events-none" />

        {/* Top Controls Bar */}
        <div className="relative z-10 flex items-center justify-between w-full">
          {/* Close button */}
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="w-9 h-9 rounded-full bg-black/50 hover:bg-black/70 active:scale-95 text-white/90 backdrop-blur-md border border-white/10 flex items-center justify-center transition-all"
              aria-label="Close scanner"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          ) : (
            <div />
          )}

          {/* Flashlight & Camera Flip Controls */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={toggleTorch}
              className={`w-9 h-9 rounded-full backdrop-blur-md border border-white/10 flex items-center justify-center transition-all active:scale-95 ${
                isTorchOn
                  ? 'bg-amber-400 text-black shadow-[0_0_14px_#F59E0B]'
                  : 'bg-black/50 hover:bg-black/70 text-white/90'
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
              className="w-9 h-9 rounded-full bg-black/50 hover:bg-black/70 active:scale-95 text-white/90 backdrop-blur-md border border-white/10 flex items-center justify-center transition-all"
              title="Flip Camera"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </div>
        </div>

        {/* Center: Scanning Frame & Gallery Pill */}
        <div className="relative z-10 flex flex-col items-center justify-center my-auto py-2">
          {cameraWarning ? (
            /* Camera Permission / Fallback Card */
            <div className="p-6 bg-black/70 backdrop-blur-md rounded-[16px] border border-white/15 text-center max-w-xs space-y-3 shadow-xl">
              <div className="w-12 h-12 mx-auto rounded-full bg-white/10 flex items-center justify-center text-white/70">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </div>
              <div className="text-[13px] font-medium text-white/90 leading-snug">
                {cameraWarning}
              </div>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-full py-2.5 px-4 bg-[#1F4FD8] hover:bg-[#183EB0] text-white text-[13px] font-medium rounded-[8px] transition-all shadow-md flex items-center justify-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <span>Upload from gallery</span>
              </button>
            </div>
          ) : (
            <>
              {/* Sleek Scanning Reticle Frame */}
              <div className="relative w-[210px] h-[210px] sm:w-[240px] sm:h-[240px] rounded-[24px] border border-white/20 backdrop-blur-[1px]">
                {/* 4 Clean Rounded Corner Brackets */}
                <div className={`absolute -top-1 -left-1 w-8 h-8 border-t-[3.5px] border-l-[3.5px] rounded-tl-[18px] transition-colors ${scanSuccess ? 'border-[#10B981]' : 'border-white'}`} />
                <div className={`absolute -top-1 -right-1 w-8 h-8 border-t-[3.5px] border-r-[3.5px] rounded-tr-[18px] transition-colors ${scanSuccess ? 'border-[#10B981]' : 'border-white'}`} />
                <div className={`absolute -bottom-1 -left-1 w-8 h-8 border-b-[3.5px] border-l-[3.5px] rounded-bl-[18px] transition-colors ${scanSuccess ? 'border-[#10B981]' : 'border-white'}`} />
                <div className={`absolute -bottom-1 -right-1 w-8 h-8 border-b-[3.5px] border-r-[3.5px] rounded-br-[18px] transition-colors ${scanSuccess ? 'border-[#10B981]' : 'border-white'}`} />

                {/* Animated Horizontal Laser Scan Beam */}
                {isScanning && !scanSuccess && (
                  <div className="scanner-beam absolute left-2 right-2 h-[2.5px] bg-gradient-to-r from-transparent via-[#60A5FA] to-transparent shadow-[0_0_12px_#3B82F6]" />
                )}

                {/* Success checkmark flash */}
                {scanSuccess && (
                  <div className="absolute inset-0 flex items-center justify-center bg-[#10B981]/25 rounded-[22px] backdrop-blur-xs">
                    <svg className="w-14 h-14 text-[#10B981] animate-in zoom-in-75 duration-200" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                )}
              </div>

              {/* Floating Action: Upload from Gallery Pill */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="mt-5 inline-flex items-center gap-2 px-4 py-2 bg-white/15 hover:bg-white/25 active:scale-95 text-white text-[12px] font-medium rounded-full backdrop-blur-md border border-white/20 transition-all shadow-md group"
              >
                <svg className="w-4 h-4 text-white/80 group-hover:text-white transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <span>Upload from gallery</span>
              </button>
            </>
          )}

          {/* Error Banner */}
          {qrError && (
            <div className="mt-3 px-3.5 py-1.5 bg-[#C0362C]/80 border border-[#C0362C] rounded-full text-[11px] text-white font-medium flex items-center gap-1.5 backdrop-blur-md">
              <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span>{qrError}</span>
            </div>
          )}
        </div>

        {/* Bottom Instructional Area */}
        <div className="relative z-10 text-center pb-1">
          <div className="text-[13px] font-semibold text-white/90">Scan payment QR code</div>
          <div className="text-[11px] text-white/50">Align QR within the frame to pay</div>
        </div>
      </div>

      {/* Quick Sample QRs for desktop/sandbox testing */}
      <div className="px-4 py-2.5 bg-[#080D1A] border-t border-white/10 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-[11px]">
        <span className="text-white/60 font-medium whitespace-nowrap">Quick Test QRs:</span>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => handleQuickSample('ACC_0015', 'Recipient', '500')}
            className="px-2 py-0.5 bg-[#141C2E] hover:bg-[#1E2B45] text-white/80 hover:text-white rounded-[4px] font-mono transition-colors border border-white/10"
          >
            ACC_0015 (₹500)
          </button>
          <button
            type="button"
            onClick={() => handleQuickSample('ACC_0042', 'Recipient', '1250')}
            className="px-2 py-0.5 bg-[#141C2E] hover:bg-[#1E2B45] text-white/80 hover:text-white rounded-[4px] font-mono transition-colors border border-white/10"
          >
            ACC_0042 (₹1,250)
          </button>
          <button
            type="button"
            onClick={() => handleQuickSample('success@razorpay', 'Sandbox Merchant', '2500')}
            className="px-2 py-0.5 bg-[#141C2E] hover:bg-[#1E2B45] text-white/80 hover:text-white rounded-[4px] font-mono transition-colors border border-white/10"
          >
            Razorpay (₹2,500)
          </button>
        </div>
      </div>
    </div>
  );
};

export default QrScannerPanel;
