"""Observe the pinned Omni workers' startup fingerprints without changing their allocation decisions."""
import json
import hashlib
from dataclasses import fields
from pathlib import Path
import torch
from vllm import __version__
from vllm.platforms import current_platform
from vllm.v1.worker.startup_plan import compute_plan_fingerprint
from vllm.config.utils import normalize_value
from vllm_omni.worker.gpu_ar_worker import GPUARWorker
from vllm_omni.worker.gpu_generation_worker import GPUGenerationWorker


class startupEvidence:
    def modelEvidence(self, phase):
        config = self.vllm_config.model_config
        values = {field.name: getattr(config, field.name, None) for field in fields(config) if field.name != "hf_token"}
        for name in ["hf_config", "hf_text_config"]:
            value = getattr(config, name, None)
            if value is not None:
                values.update({name + "." + key: item for key, item in value.to_dict().items() if key not in {"hf_token", "token"}})
        records = []
        for name, value in values.items():
            try:
                normalized = normalize_value(value)
                record = {"field": name, "hash": hashlib.sha256(json.dumps(normalized, sort_keys=True).encode()).hexdigest()}
                if normalized is None or isinstance(normalized, (bool, int)) or isinstance(normalized, str) and len(normalized) <= 80:
                    record["value"] = normalized
                if len(json.dumps(record, separators=(",", ":"))) > 250:
                    record.pop("value", None)
                records.append(record)
            except (TypeError, ValueError):
                records.append({"field": name, "unavailable": True})
        return [{"phase": phase, "modelFields": records[index:index + 6]} for index in range(0, len(records), 6)]

    def fingerprintEvidence(self, phase):
        config = self.vllm_config
        components = {name: value.compute_hash() for name, value in vars(config).items() if callable(getattr(value, "compute_hash", None))}
        if isinstance(config.additional_config, dict):
            components["additional_config"] = hashlib.sha256(json.dumps(config.additional_config, sort_keys=True).encode()).hexdigest()[:16]
        return {"phase": phase, "fingerprint": compute_plan_fingerprint(config, self.rank, self.parallel_config.world_size), "components": components, "device": current_platform.get_device_name(), "memory": current_platform.get_device_total_memory(), "capability": str(current_platform.get_device_capability()), "torch": torch.__version__, "cuda": torch.version.cuda, "vllm": __version__}

    def determine_available_memory(self):
        before = self.fingerprintEvidence("beforeProfiling")
        modelBefore = self.modelEvidence("beforeModelFields")
        result = super().determine_available_memory()
        after = self.fingerprintEvidence("afterProfiling")
        destination = Path(f"/content/drama3Runtime/startupEvidence{self.stageId}.json")
        temporary = destination.with_suffix(".tmp")
        temporary.write_text(json.dumps([before, *modelBefore, after, *self.modelEvidence("afterModelFields")]))
        temporary.replace(destination)
        return result


class arWorker(startupEvidence, GPUARWorker):
    stageId = 0


class codecWorker(startupEvidence, GPUGenerationWorker):
    stageId = 1
