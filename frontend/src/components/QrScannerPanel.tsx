import React, { useState, useRef, useEffect } from 'react';
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
  initialTab?: 'upload' | 'camera' | 'manual';
}

export const QrScannerPanel: React.FC<QrScannerPanelProps> = ({ onUpiDecoded, initialTab = 'upload' }) => {
  const [activeTab, setActiveTab] = useState<'upload' | 'camera' | 'manual'>(initialTab);
  const [qrError, setQrError] = useState<string | null>(null);
  const [manualInput, setManualInput] = useState('');
  const [cameraWarning, setCameraWarning] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Check secure context for camera
  const isSecure = typeof window !== 'undefined' && (
    window.isSecureContext ||
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1'
  );

  const stopCamera = () => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  };

  useEffect(() => {
    if (initialTab === 'camera') {
      startCamera();
    }
    return () => {
      stopCamera();
    };
  }, []);

  // Strict UPI Parser
  const parseAndValidateUpi = (rawString: string): boolean => {
    setQrError(null);
    const trimmed = rawString.trim();

    if (!trimmed.toLowerCase().startsWith('upi://pay?')) {
      setQrError('This is not a UPI payment QR.');
      return false;
    }

    try {
      const queryPart = trimmed.slice(trimmed.indexOf('?') + 1);
      const params = new URLSearchParams(queryPart);

      const pa = params.get('pa');
      const pn = params.get('pn') || undefined;
      const am = params.get('am') || undefined;
      const cu = params.get('cu') || 'INR';

      if (!pa) {
        setQrError('This is not a UPI payment QR (missing payee address).');
        return false;
      }

      // Validate pa: letters, digits, dot, dash, underscore, then @, then letters
      const paRegex = /^[a-zA-Z0-9.\-_]+@[a-zA-Z]+$/;
      if (!paRegex.test(pa)) {
        setQrError(`Invalid UPI ID format: "${pa}". Expected user@bank.`);
        return false;
      }

      // Check currency if present
      if (cu.toUpperCase() !== 'INR') {
        setQrError(`Unsupported currency "${cu}". Only INR is supported.`);
        return false;
      }

      // Validate am if present: positive number with at most 2 decimals
      if (am) {
        const amRegex = /^\d+(\.\d{1,2})?$/;
        const numAm = parseFloat(am);
        if (!amRegex.test(am) || isNaN(numAm) || numAm <= 0) {
          setQrError(`Invalid amount "${am}". Must be a positive number with at most 2 decimals.`);
          return false;
        }
      }

      onUpiDecoded({
        pa,
        pn,
        am,
        cu,
        rawString: trimmed,
      });

      return true;
    } catch {
      setQrError('Failed to parse UPI payment QR string.');
      return false;
    }
  };

  // Image upload decode
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
          setQrError('Image decoding is not supported on this browser.');
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
          setQrError('No QR code detected in this image. Please upload a clear QR photo.');
        }
      };

      img.onerror = () => {
        setQrError('Failed to load image file.');
      };

      img.src = event.target?.result as string;
    };

    reader.readAsDataURL(file);
    // Reset file input value
    e.target.value = '';
  };

  // Live Camera Scanning
  const startCamera = async () => {
    setQrError(null);
    setCameraWarning(null);

    if (!isSecure) {
      setCameraWarning('Camera needs https or localhost. Use upload or enter the UPI ID.');
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraWarning('Camera API is not supported on this browser.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } },
      });
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.setAttribute('playsinline', 'true');
        await videoRef.current.play();
        scanCameraFrame();
      }
    } catch (err: any) {
      stopCamera();
      setQrError(`Could not access camera: ${err.message || 'Permission denied'}`);
    }
  };

  const scanCameraFrame = () => {
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
  };

  // Manual UPI form submit
  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualInput.trim()) return;

    let targetUri = manualInput.trim();
    if (!targetUri.toLowerCase().startsWith('upi://pay?')) {
      targetUri = `upi://pay?pa=${encodeURIComponent(targetUri)}&cu=INR`;
    }
    parseAndValidateUpi(targetUri);
  };

  return (
    <div className="w-full bg-[#FFFFFF] border border-[#DCE0E7] rounded-[6px] p-4 text-[13px] text-[#1B2433]">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
        <div>
          <div className="font-medium text-[#1B2433]">Scan QR or enter UPI</div>
          <div className="text-[11px] text-[#8A94A6]">Pre-fills recipient and amount. Never pays automatically.</div>
        </div>

        {/* 3 Input Path Tabs */}
        <div className="flex w-full sm:w-auto bg-[#F4F5F7] p-0.5 rounded-[6px] border border-[#E3E7EE]">
          <button
            type="button"
            onClick={() => {
              stopCamera();
              setActiveTab('upload');
            }}
            className={`flex-1 sm:flex-initial px-3 py-1 text-[12px] font-medium rounded-[4px] whitespace-nowrap transition-colors ${
              activeTab === 'upload' ? 'bg-[#FFFFFF] text-[#1B2433] shadow-sm' : 'text-[#8A94A6] hover:text-[#1B2433]'
            }`}
          >
            Upload
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveTab('camera');
              startCamera();
            }}
            className={`flex-1 sm:flex-initial px-3 py-1 text-[12px] font-medium rounded-[4px] whitespace-nowrap transition-colors ${
              activeTab === 'camera' ? 'bg-[#FFFFFF] text-[#1F4FD8] shadow-sm' : 'text-[#8A94A6] hover:text-[#1B2433]'
            }`}
          >
            Camera
          </button>
          <button
            type="button"
            onClick={() => {
              stopCamera();
              setActiveTab('manual');
            }}
            className={`flex-1 sm:flex-initial px-3 py-1 text-[12px] font-medium rounded-[4px] whitespace-nowrap transition-colors ${
              activeTab === 'manual' ? 'bg-[#FFFFFF] text-[#1B2433] shadow-sm' : 'text-[#8A94A6] hover:text-[#1B2433]'
            }`}
          >
            Manual
          </button>
        </div>
      </div>

      {/* Error / Warning Alert */}
      {qrError && (
        <div className="mb-3 p-2.5 bg-[#C0362C]/10 border border-[#C0362C]/20 rounded-[4px] text-[12px] text-[#C0362C]">
          {qrError}
        </div>
      )}

      {/* Path 1: Image Upload */}
      {activeTab === 'upload' && (
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileUpload}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="w-full py-3 px-4 border border-dashed border-[#DCE0E7] hover:border-[#1F4FD8] rounded-[6px] bg-[#F4F5F7]/50 hover:bg-[#F4F5F7] text-center transition-colors group cursor-pointer"
          >
            <div className="text-[13px] font-medium text-[#1B2433] group-hover:text-[#1F4FD8]">
              Choose QR code image file
            </div>
            <div className="text-[11px] text-[#5B6575] mt-0.5">
              PNG, JPG, or screenshot containing a Bharat/UPI payment QR
            </div>
          </button>
        </div>
      )}

      {/* Path 2: Live Camera Viewfinder */}
      {activeTab === 'camera' && (
        <div className="space-y-2">
          {cameraWarning ? (
            <div className="p-3 bg-[#B7791F]/10 border border-[#B7791F]/20 rounded-[4px] text-[12px] text-[#B7791F]">
              {cameraWarning}
            </div>
          ) : (
            <div className="relative bg-[#1B2433] rounded-[6px] overflow-hidden max-h-[240px] flex items-center justify-center">
              <video
                ref={videoRef}
                className="w-full h-[240px] object-cover"
                autoPlay
                muted
                playsInline
              />
              <div className="absolute inset-0 border-2 border-dashed border-[#FFFFFF]/40 pointer-events-none m-6 rounded-[4px]" />
              <button
                type="button"
                onClick={stopCamera}
                className="absolute top-2 right-2 px-2 py-1 bg-[#1B2433]/80 hover:bg-[#1B2433] text-[#FFFFFF] text-[11px] rounded-[4px]"
              >
                Close camera
              </button>
            </div>
          )}
        </div>
      )}

      {/* Path 3: Manual UPI ID */}
      {activeTab === 'manual' && (
        <form onSubmit={handleManualSubmit} className="flex gap-2">
          <input
            type="text"
            required
            placeholder="Enter account ID or UPI URI"
            value={manualInput}
            onChange={(e) => setManualInput(e.target.value)}
            className="flex-1 px-3 py-2 bg-[#FFFFFF] border border-[#DCE0E7] rounded-[6px] font-mono text-[12px] text-[#1B2433] focus:border-[#1F4FD8] focus:ring-1 focus:ring-[#1F4FD8]"
          />
          <button
            type="submit"
            className="px-3 py-2 bg-[#1F4FD8] text-[#FFFFFF] text-[12px] font-medium rounded-[6px] hover:bg-[#183EB0] transition-colors"
          >
            Apply
          </button>
        </form>
      )}
    </div>
  );
};
