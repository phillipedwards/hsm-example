import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as tls from "@pulumi/tls";
import { CloudHSMV2, Cluster } from "@aws-sdk/client-cloudhsm-v2";
import { fromIni } from "@aws-sdk/credential-provider-ini";
import { Target } from "@pulumi/aws/appautoscaling";

export = async () => {
    const config = new pulumi.Config("aws");
    const region = config.require("region");
    const profile = config.require("profile");

    const vpc = new awsx.ec2.Vpc("vpc", {
        cidrBlock: "10.100.0.0/16",
    });

    const cluster = new aws.cloudhsmv2.Cluster("cluster", {
        hsmType: "hsm1.medium",
        subnetIds: vpc.publicSubnetIds,
    });

    const privateKey = new tls.PrivateKey("pk", {
        algorithm: "RSA",
        rsaBits: 2048
    });

    const hsm = new aws.cloudhsmv2.Hsm("hsm1", {
        clusterId: cluster.id,
        subnetId: vpc.publicSubnetIds.apply(subs => subs[0]),
    });

    const cloudhsm = new CloudHSMV2({
        region: region,
        credentials: fromIni({ profile: profile })
    });

    const uninitializedCluster = await getHsmClusterStatus(cloudhsm, cluster.id, ["UNINITIALIZED"]);
    const hsmPrivateKey = new tls.PrivateKey("cluster-pk", {
        algorithm: "RSA",
        rsaBits: 2048
    });

    const validHours = 24 * 365 * 10; // 10 years
    const hsmSelfSignedCert = new tls.SelfSignedCert("cluster-selfsigned", {
        privateKeyPem: privateKey.privateKeyPem,
        isCaCertificate: true,
        subject: {
            country: "US",
            postalCode: "CA",
            organization: "Pulumi Cert Testing LTD"
        },
        allowedUses: [
            "digital_signature",
            "cert_signing",
            "crl_signing",
        ],
        validityPeriodHours: validHours
    });

    const clusterCsr = uninitializedCluster?.cluster.Certificates?.apply(c => {
        console.log(c!.ClusterCsr!);
        return c!.ClusterCsr!;
    }) ?? "";

    const hsmSignedCert = new tls.LocallySignedCert("cluster-cert", {
        certRequestPem: clusterCsr,
        caPrivateKeyPem: hsmPrivateKey.privateKeyPem,
        caCertPem: hsmSelfSignedCert.certPem,
        validityPeriodHours: validHours,
        allowedUses: [
            "digital_signature",
            "key_encipherment",
            "server_auth",
            "client_auth",
        ]
    });

    // note this will initialize the cluster and then wait for the cluster to reach the "INITIALIZED" status which is our signal to add additional HSMs.
    const initializedCluster = await initializeHsmCluster(cloudhsm, cluster.id, hsmSignedCert.certPem, hsmSignedCert.caPrivateKeyPem);

    // below we use the initializedCluster.clusterId to force the below HSM to wait until we get to the appropriate status.
    const hsm2 = new aws.cloudhsmv2.Hsm("hsm2", {
        clusterId: initializedCluster?.clusterId ?? "",
        subnetId: vpc.publicSubnetIds.apply(subs => subs[0])
    }); 

    return {
        clusterState: uninitializedCluster?.clusterStatus,
        clusterCsr: uninitializedCluster?.cluster.Certificates?.apply(c => c?.ClusterCsr),
        clusterId: cluster.id,
        hsm2Id: hsm2.id,
    }
}

interface HsmClusterStatus {
    clusterId: pulumi.Output<string>;
    clusterStatus: pulumi.Output<string>;
    cluster: pulumi.Output<Cluster>;
}

// This function takes a AWS SDK CloudHSMV2 object, as well as the needed cluster items
// it's goal is to initialize the cluster, poll the AWS API, and once the cluster reaches the INITIALIZED state, return the given data.
async function initializeHsmCluster(
    hsm: CloudHSMV2,
    clusterId: pulumi.Output<string>,
    signedCert: pulumi.Output<string>,
    trustAnchor: pulumi.Output<string>) {

    if (pulumi.runtime.isDryRun()) {
        return;
    }
    
    // using the HSM certificates as inputs, you can initialize the cluster from the AWS API
    const state = pulumi.all([clusterId, signedCert, trustAnchor]).apply(async ([id, cert, trust]) => {
        const initRequest = await hsm.initializeCluster({
            ClusterId: id,
            SignedCert: cert,
            TrustAnchor: trust,
        });

        return initRequest.State;
    });

    // once we give the initialize command, lets wait until the cluster is in our target state before returning.
    return await getHsmClusterStatus(hsm, clusterId, ["INITIALIZED"]);
}

// This function takes a AWS SDK CloudHSMV2 object, as well as the needed cluster items, plus targetStatues and timeout limit.
// The goal is to poll the AWS API and wait until the cluster reaches the target state or the time allotment is reached.
async function getHsmClusterStatus(hsm: CloudHSMV2, clusterId: pulumi.Output<string>, targetStatuses: string[], timeoutSeconds?: number): Promise<HsmClusterStatus | undefined> {
    if (pulumi.runtime.isDryRun()) {
        return;
    }

    if (!timeoutSeconds) {
        timeoutSeconds = 10 * 60
    }

    const clusterOutputs = clusterId.apply(async id => {
        // max allowed time is 20 mins per use of this func
        // could use some available packages but we will guessimate each loop takes 10 seconds w/ the sleep included
        const maxAttempts = 1 * 60 / 10; // 20 mins * 60 secs / 10 secs = 120 attempts
        let attempts = 0;
        while (true) {

            const result = await hsm.describeClusters({
                Filters: {
                    "clusterIds": [
                        id,
                    ]
                }
            });

            if (!result.Clusters) {
                console.log("No cluster found for given cluster id");
                throw new Error("Cluster not found");
            }

            const cluster = result.Clusters.find(cluster => cluster.ClusterId == id);
            if (!cluster) {
                console.log(`Unable to find cluster by id ${clusterId}`);
                throw new Error(`Unable to find cluster by id ${clusterId}`);
            }

            attempts++;
            if (targetStatuses.includes(cluster.State!)) {
                return {
                    clusterStatus: cluster.State!,
                    clusterId: cluster.ClusterId!,
                    cluster: cluster,
                }
            } else {
                if (attempts > maxAttempts) {
                    throw new Error(`Unable to obtain desired cluster state of ${targetStatuses.join(",")} in the alloted timeframe`);
                }

                console.log(`Cluster state ${cluster.State} does not match desired state of ${targetStatuses.join(",")}. Will retry...`);
                await sleep(10000); // 10 seconds
            }
        }
    });

    return {
        clusterId: clusterOutputs.clusterId,
        clusterStatus: clusterOutputs.clusterStatus,
        cluster: clusterOutputs.cluster,
    };
}

async function sleep(ms: number) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}