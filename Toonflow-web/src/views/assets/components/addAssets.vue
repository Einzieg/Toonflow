<template>
  <div class="addAssets">
    <t-dialog
      v-model:visible="addAssetsShow"
      :closable="false"
      width="40vw"
      :header="props.title"
      :maskClosable="false"
      @close-btn-click="handleCancel"
      @confirm="onConfirm"
      @cancel="handleCancel">
      <div class="data">
        <t-form :data="props.formData" :rules="rules" ref="formRef">
          <t-form-item :label="$t('workbench.assets.add.name')" name="name">
            <t-input v-model="props.formData.name" :placeholder="$t('workbench.assets.add.namePh')"></t-input>
          </t-form-item>
          <t-form-item :label="$t('workbench.assets.add.describe')" name="describe">
            <t-textarea v-model="props.formData.describe" :placeholder="$t('workbench.assets.add.describePh')"></t-textarea>
          </t-form-item>
          <t-form-item :label="$t('workbench.assets.add.remark')" name="remark">
            <t-input v-model="props.formData.remark" :placeholder="$t('workbench.assets.add.remarkPh')"></t-input>
          </t-form-item>
          <t-form-item :label="$t('workbench.assets.add.prompt')" name="prompt" v-if="props.type !== 'clip'">
            <t-textarea
              v-model="props.formData.prompt"
              :autosize="{ minRows: 3, maxRows: 5 }"
              :placeholder="$t('workbench.assets.add.promptPh')"></t-textarea>
          </t-form-item>
          <t-form-item :label="$t('workbench.assets.add.volcengineAssetUri')" name="volcengineAssetUri" v-if="props.type === 'role'">
            <t-input
              v-model="volcengineAssetUriModel"
              :placeholder="$t('workbench.assets.add.volcengineAssetUriPh')"></t-input>
          </t-form-item>
          <template v-if="props.type === 'role'">
            <t-form-item label="声线" name="voiceProfile">
              <t-input v-model="voiceProfileModel" placeholder="如：低沉磁性、少年感清亮、温柔女声、沙哑沧桑" />
            </t-form-item>
            <t-form-item label="语气" name="voiceTone">
              <t-input v-model="voiceToneModel" placeholder="如：克制冷静、温柔坚定、急促紧张、疲惫低落" />
            </t-form-item>
            <t-form-item label="语速" name="speechRate">
              <t-input v-model="speechRateModel" placeholder="如：慢速、正常、偏快、短句停顿明显" />
            </t-form-item>
          </template>
        </t-form>
      </div>
    </t-dialog>
  </div>
</template>

<script setup lang="ts">
import axios from "@/utils/axios";
import projectStore from "@/stores/project";
const { project } = storeToRefs(projectStore());
const props = defineProps<{
  type: "role" | "tool" | "scene" | "clip" | "audio";
  title: string;
  formData: {
    id: number;
    name: string;
    describe: string;
    remark: string;
    prompt: string;
    volcengineAssetUri?: string | null;
    voiceProfile?: string | null;
    voiceTone?: string | null;
    speechRate?: string | null;
  };
}>();
const addAssetsShow = defineModel<boolean>({
  default: false,
});
function nullableStringModel(key: "volcengineAssetUri" | "voiceProfile" | "voiceTone" | "speechRate") {
  return computed({
    get: () => props.formData[key] ?? "",
    set: (value) => {
      props.formData[key] = String(value ?? "");
    },
  });
}
const volcengineAssetUriModel = nullableStringModel("volcengineAssetUri");
const voiceProfileModel = nullableStringModel("voiceProfile");
const voiceToneModel = nullableStringModel("voiceTone");
const speechRateModel = nullableStringModel("speechRate");
const rules = ref<{}>({
  name: [{ required: true, message: $t("workbench.assets.add.nameRequired"), trigger: "blur" }],
  describe: [{ required: true, message: $t("workbench.assets.add.describeRequired"), trigger: "blur" }],
});
function handleCancel() {
  addAssetsShow.value = false;
}
const formRef = ref();
const emit = defineEmits(["getFilteredData"]);
function onConfirm() {
  formRef.value?.validate().then(async (result: any) => {
    if (result == true) {
      if (props.formData.id !== 0) {
        await axios
          .post(`/assets/updateAssets`, {
            id: props.formData.id,
            name: props.formData.name,
            describe: props.formData.describe,
            remark: props.formData.remark,
            prompt: props.formData.prompt,
            volcengineAssetUri: props.formData.volcengineAssetUri,
            voiceProfile: props.formData.voiceProfile,
            voiceTone: props.formData.voiceTone,
            speechRate: props.formData.speechRate,
          })
          .then(() => {
            window.$message.success($t("workbench.assets.add.updateSuccess"));
            emit("getFilteredData");
            addAssetsShow.value = false;
          });
      } else {
        await axios
          .post(`/assets/addAssets`, {
            name: props.formData.name,
            describe: props.formData.describe,
            remark: props.formData.remark,
            type: props.type,
            projectId: project.value?.id,
            prompt: props.formData.prompt,
            volcengineAssetUri: props.formData.volcengineAssetUri,
            voiceProfile: props.formData.voiceProfile,
            voiceTone: props.formData.voiceTone,
            speechRate: props.formData.speechRate,
          })
          .then(() => {
            window.$message.success($t("workbench.assets.add.addSuccess"));
            emit("getFilteredData");
            addAssetsShow.value = false;
          });
      }
    }
  });
}
</script>

<style lang="scss" scoped>
.addAssets {
  .modalHeader {
    background: var(--td-bg-color-container);
    width: 100%;
    :deep(.ant-typography) {
      color: var(--td-text-color-primary);
      margin: 0;
    }

    :deep(.ant-btn-text) {
      color: var(--td-brand-color);

      &:hover {
        background: var(--td-bg-color-component-hover);
        color: var(--td-brand-color-hover);
      }
    }
  }
  .data {
    width: 100%;
  }
}
</style>
